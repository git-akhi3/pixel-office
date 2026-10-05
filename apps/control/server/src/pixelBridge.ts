// Shows the office's agents in the Pixel Agents office without modifying Pixel Agents.
//
// Pixel Agents builds sub-agents (and so the resident characters) from a session's transcript file,
// and learns about new sessions from Claude Code-style hooks. The office therefore appears as one
// session: it writes a small transcript of its own and announces it through the hook endpoint.
// Each agent step is an "Agent" tool call with subagent_type = the role, so the matching resident
// (coder, reviewer, ...) works at its desk, labelled with the task. A gate shows the waiting bubble.
//
// Once adopted through hooks, Pixel Agents takes turn ends from the Stop hook, not the transcript,
// so going idle needs both. The transcript lives in the project folder of the pixel office's
// workspace (~/.office/pixel by default, see start.sh), so it never appears in a real repo's history.

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Task } from './db/schema.js';
import type { EventBus } from './events.js';

export interface PixelServer {
  port: number;
  token: string;
  pid: number;
}

export interface BridgeOptions {
  /** ~/.pixel-agents (servers/*.json registry, layout.json with residents). */
  pixelHome?: string;
  /** ~/.claude/projects: where Claude Code (and so Pixel Agents) keeps transcripts. */
  projectsRoot?: string;
  /** File written by start.sh with the pixel office's workspace (the project it watches). */
  workspaceFile: string;
  /** Session id (a UUID) of the office in Pixel Agents. */
  sessionId?: string;
  /** Called with a new session id when the transcript is rotated, so it can be persisted. */
  onRotate?: (sessionId: string) => void;
  /** Rotate the transcript beyond this size. */
  maxTranscriptBytes?: number;
  hookTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  taskTitle: (taskId: number) => string | null;
}

/** Claude Code's project-folder naming (same as Pixel Agents' normalizeProjectPath). */
export const projectDirName = (absPath: string) => absPath.replace(/[^a-zA-Z0-9-]/g, '-');

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists, just not ours to signal
  }
}

export class PixelBridge {
  private pixelHome: string;
  private projectsRoot: string;
  private _sessionId: string;
  private fetchImpl: typeof fetch;
  /** "pid:port" of the pixel server the office was announced to; a new server means announce again. */
  private announcedTo: string | null = null;
  /** A previous run of the control server may have left a turn open (crash mid-step). */
  private staleTurn = true;
  /** runId → tool_use id of steps currently shown as working. */
  private active = new Map<number, string>();
  /** Events are handled one at a time, in order (announce, then tool_use before tool_result). */
  private queue: Promise<void> = Promise.resolve();
  private unsubscribe?: () => void;

  constructor(private opts: BridgeOptions) {
    this.pixelHome = opts.pixelHome ?? join(homedir(), '.pixel-agents');
    this.projectsRoot = opts.projectsRoot ?? join(homedir(), '.claude', 'projects');
    this._sessionId = opts.sessionId ?? randomUUID();
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  start(bus: EventBus): void {
    this.unsubscribe = bus.subscribe((msg) => {
      if (msg.type !== 'event' || msg.event.taskId === null) return;
      const { type, payload, runId, taskId } = msg.event;
      void this.enqueue(type, payload, taskId, runId);
    });
    // Announce right away, which also closes a turn a crashed run left "working".
    void this.enqueue('startup', {}, 0, null);
  }

  stop(): void {
    this.unsubscribe?.();
  }

  /** Queues an event behind earlier ones. Never rejects. */
  enqueue(type: string, payload: Record<string, unknown>, taskId: number, runId: number | null): Promise<void> {
    this.queue = this.queue.then(() => this.onEvent(type, payload, taskId, runId)).catch(() => {});
    return this.queue;
  }

  /**
   * The running pixel server that serves the office scene: the newest live entry in Pixel Agents'
   * registry (~/.pixel-agents/servers/*.json) with servesSpa. server.json is only a last-writer-wins
   * pointer and may name a VS Code extension's embedded server instead.
   */
  server(): PixelServer | null {
    const dir = join(this.pixelHome, 'servers');
    let best: (PixelServer & { startedAt: number }) | null = null;
    try {
      for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
        try {
          const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { port?: number; token?: string; pid?: number; servesSpa?: boolean; startedAt?: number };
          if (!j.port || !j.token || !j.pid || !j.servesSpa || !alive(j.pid)) continue;
          if (!best || (j.startedAt ?? 0) > best.startedAt) best = { port: j.port, token: j.token, pid: j.pid, startedAt: j.startedAt ?? 0 };
        } catch {
          // unreadable entry: skip
        }
      }
    } catch {
      return null;
    }
    return best && { port: best.port, token: best.token, pid: best.pid };
  }

  /** The pixel office's workspace, from the file start.sh writes. */
  workspace(): string | null {
    if (!existsSync(this.opts.workspaceFile)) return null;
    return readFileSync(this.opts.workspaceFile, 'utf8').trim() || null;
  }

  /** Where the office's transcript goes: the workspace's Claude project folder, which Pixel Agents tracks. */
  transcriptPath(sessionId = this._sessionId): string | null {
    const workspace = this.workspace();
    return workspace ? join(this.projectsRoot, projectDirName(workspace), `${sessionId}.jsonl`) : null;
  }

  /** The office layout's width / height, so a page can size a frame to fit it exactly. */
  layoutAspect(): number | null {
    try {
      const layout = JSON.parse(readFileSync(join(this.pixelHome, 'layout.json'), 'utf8')) as { cols?: number; rows?: number };
      return layout.cols && layout.rows ? layout.cols / layout.rows : null;
    } catch {
      return null;
    }
  }

  /** Resident character for a role: same name, or the architect at the designer's desk in older layouts. */
  residentFor(role: string): string {
    let residents: string[] = [];
    try {
      const layout = JSON.parse(readFileSync(join(this.pixelHome, 'layout.json'), 'utf8')) as { residents?: Array<{ name: string }> };
      residents = (layout.residents ?? []).map((r) => r.name);
    } catch {
      // no layout: Pixel Agents shows a transient Subtask character instead
    }
    if (residents.includes(role)) return role;
    if (role === 'architect' && residents.includes('designer')) return 'designer';
    return role;
  }

  private async hook(server: PixelServer, body: Record<string, unknown>, sessionId = this._sessionId): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`http://127.0.0.1:${server.port}/api/hooks/claude`, {
        method: 'POST',
        headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, ...body }),
        signal: AbortSignal.timeout(this.opts.hookTimeoutMs ?? 2000),
      });
      if (!res.ok) this.announcedTo = null;
      return res.ok;
    } catch {
      this.announcedTo = null; // unreachable or hung: announce again next time
      return false;
    }
  }

  private append(record: Record<string, unknown>): void {
    const path = this.transcriptPath();
    if (!path) return;
    appendFileSync(path, JSON.stringify({ sessionId: this._sessionId, uuid: randomUUID(), timestamp: new Date().toISOString(), ...record }) + '\n');
  }

  /** Ends the current turn in both places Pixel Agents may look: transcript and Stop hook. */
  private async endTurn(server: PixelServer): Promise<void> {
    this.append({ type: 'system', subtype: 'turn_duration', durationMs: 0 });
    await this.hook(server, { hook_event_name: 'Stop' });
  }

  /** Starts a fresh transcript under a new session id once the current one is too big. */
  private async rotateIfLarge(server: PixelServer): Promise<void> {
    const path = this.transcriptPath();
    if (!path || !existsSync(path) || this.active.size) return;
    if (statSync(path).size < (this.opts.maxTranscriptBytes ?? 2_000_000)) return;
    const old = this._sessionId;
    await this.hook(server, { hook_event_name: 'SessionEnd', reason: 'other' }, old);
    this._sessionId = randomUUID();
    this.opts.onRotate?.(this._sessionId);
    this.announcedTo = null;
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
  }

  /**
   * Creates the transcript and announces the session to the current pixel server (again whenever
   * that server changes). Confirmed with PostToolUse, which adopts the session without the "done"
   * chime a Stop would play.
   */
  private async announce(server: PixelServer): Promise<boolean> {
    const key = `${server.pid}:${server.port}`;
    if (this.announcedTo === key) return true;
    const workspace = this.workspace();
    const path = this.transcriptPath();
    if (!workspace || !path) return false;
    mkdirSync(join(path, '..'), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, '');
    const base = { cwd: workspace, transcript_path: path };
    if (!(await this.hook(server, { hook_event_name: 'SessionStart', source: 'startup', ...base }))) return false;
    if (!(await this.hook(server, { hook_event_name: 'PostToolUse', tool_name: 'Agent', ...base }))) return false;
    this.announcedTo = key;
    // Close anything a crashed run of the control server left "working".
    if (this.staleTurn) {
      this.staleTurn = false;
      if (!this.active.size) await this.endTurn(server);
    }
    return true;
  }

  async onEvent(type: string, payload: Record<string, unknown>, taskId: number, runId: number | null): Promise<void> {
    if (!['startup', 'step_start', 'step_end', 'gate', 'gate_decided'].includes(type)) return;
    const server = this.server();
    if (!server) {
      this.announcedTo = null;
      return;
    }
    if (type === 'step_start') await this.rotateIfLarge(server);
    if (!(await this.announce(server))) return;
    switch (type) {
      case 'step_start': {
        if (runId === null) return;
        const toolId = `toolu_office_${runId}`;
        this.active.set(runId, toolId);
        const title = this.opts.taskTitle(taskId) ?? `task ${taskId}`;
        this.append({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: toolId,
                name: 'Agent',
                input: { subagent_type: this.residentFor(String(payload.role)), description: `#${taskId} ${title}`.slice(0, 80) },
              },
            ],
          },
        });
        return;
      }
      case 'step_end': {
        const toolId = runId !== null ? this.active.get(runId) : undefined;
        if (runId !== null) this.active.delete(runId);
        if (toolId) {
          this.append({
            type: 'user',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: String(payload.status ?? 'done') }] },
          });
        }
        if (!this.active.size) await this.endTurn(server); // nothing else running: everyone idles
        return;
      }
      case 'gate':
        if (payload.status === 'pending') {
          await this.hook(server, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: `#${taskId} needs you` });
        }
        return;
      case 'gate_decided':
        if (!this.active.size) await this.hook(server, { hook_event_name: 'Stop' });
        return;
    }
  }
}

/** Title lookup that tolerates deleted tasks. */
export const titleFrom = (getTask: (id: number) => Task) => (id: number) => {
  try {
    return getTask(id).title;
  } catch {
    return null;
  }
};
