// Shows the office's agents in the Pixel Agents office without modifying Pixel Agents.
//
// Pixel Agents builds sub-agents (and so the resident characters) from a session's transcript file,
// and learns about new sessions from Claude Code-style hooks. The office therefore appears as one
// session: it writes a small transcript of its own and announces it through the hook endpoint.
// Each agent step is an "Agent" tool call with subagent_type = the role, so the matching resident
// (coder, reviewer, ...) works at its desk, labelled with the task. A gate shows the waiting bubble.
//
// The transcript lives in the project folder of the pixel office's workspace (~/.office/pixel by
// default, see start.sh), so it never appears in the session history of a real repo.

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Task } from './db/schema.js';
import type { EventBus } from './events.js';

export interface PixelServer {
  port: number;
  token: string;
}

export interface BridgeOptions {
  /** ~/.pixel-agents (server.json with port + token, layout.json with residents). */
  pixelHome?: string;
  /** ~/.claude/projects: where Claude Code (and so Pixel Agents) keeps transcripts. */
  projectsRoot?: string;
  /** File written by start.sh with the pixel office's workspace (the project it watches). */
  workspaceFile: string;
  /** Stable session id (a UUID) of the office in Pixel Agents. */
  sessionId?: string;
  fetchImpl?: typeof fetch;
  taskTitle: (taskId: number) => string | null;
}

/** Claude Code's project-folder naming (same as Pixel Agents' normalizeProjectPath). */
export const projectDirName = (absPath: string) => absPath.replace(/[^a-zA-Z0-9-]/g, '-');

export class PixelBridge {
  private pixelHome: string;
  private projectsRoot: string;
  readonly sessionId: string;
  private fetchImpl: typeof fetch;
  private announced = false;
  /** runId → tool_use id of steps currently shown as working. */
  private active = new Map<number, string>();
  private unsubscribe?: () => void;

  constructor(private opts: BridgeOptions) {
    this.pixelHome = opts.pixelHome ?? join(homedir(), '.pixel-agents');
    this.projectsRoot = opts.projectsRoot ?? join(homedir(), '.claude', 'projects');
    this.sessionId = opts.sessionId ?? randomUUID();
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  start(bus: EventBus): void {
    this.unsubscribe = bus.subscribe((msg) => {
      if (msg.type !== 'event' || msg.event.taskId === null) return;
      const { type, payload, runId, taskId } = msg.event;
      void this.onEvent(type, payload, taskId, runId).catch(() => {});
    });
  }

  stop(): void {
    this.unsubscribe?.();
  }

  /** The pixel server's port and hook token, or null when it isn't running. */
  server(): PixelServer | null {
    try {
      const j = JSON.parse(readFileSync(join(this.pixelHome, 'server.json'), 'utf8')) as { port?: number; token?: string; pid?: number };
      if (!j.port || !j.token) return null;
      if (j.pid) process.kill(j.pid, 0); // throws if the process is gone
      return { port: j.port, token: j.token };
    } catch {
      return null;
    }
  }

  /** The pixel office's workspace, from the file start.sh writes. */
  workspace(): string | null {
    if (!existsSync(this.opts.workspaceFile)) return null;
    return readFileSync(this.opts.workspaceFile, 'utf8').trim() || null;
  }

  /** Where the office's transcript goes: the workspace's Claude project folder, which Pixel Agents tracks. */
  transcriptPath(): string | null {
    const workspace = this.workspace();
    return workspace ? join(this.projectsRoot, projectDirName(workspace), `${this.sessionId}.jsonl`) : null;
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

  private async hook(body: Record<string, unknown>): Promise<boolean> {
    const server = this.server();
    if (!server) {
      this.announced = false; // announce again when the pixel office comes back
      return false;
    }
    const res = await this.fetchImpl(`http://127.0.0.1:${server.port}/api/hooks/claude`, {
      method: 'POST',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: this.sessionId, ...body }),
    });
    if (!res.ok) this.announced = false;
    return res.ok;
  }

  private append(record: Record<string, unknown>): void {
    const path = this.transcriptPath();
    if (!path) return;
    appendFileSync(path, JSON.stringify({ sessionId: this.sessionId, uuid: randomUUID(), timestamp: new Date().toISOString(), ...record }) + '\n');
  }

  /** Creates the transcript and announces the session (SessionStart, confirmed by a turn end). */
  private async announce(): Promise<boolean> {
    if (this.announced) return true;
    const workspace = this.workspace();
    const path = this.transcriptPath();
    if (!workspace || !path || !this.server()) return false;
    mkdirSync(join(path, '..'), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, '');
    const base = { cwd: workspace, transcript_path: path };
    if (!(await this.hook({ hook_event_name: 'SessionStart', source: 'startup', ...base }))) return false;
    this.announced = await this.hook({ hook_event_name: 'Stop', ...base });
    return this.announced;
  }

  async onEvent(type: string, payload: Record<string, unknown>, taskId: number, runId: number | null): Promise<void> {
    if (!['step_start', 'step_end', 'gate', 'gate_decided'].includes(type)) return;
    if (!(await this.announce())) return;
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
        // Nothing else running: end the turn so the office goes idle.
        if (!this.active.size) this.append({ type: 'system', subtype: 'turn_duration', durationMs: 0 });
        return;
      }
      case 'gate':
        if (payload.status === 'pending') {
          await this.hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: `#${taskId} needs you` });
        }
        return;
      case 'gate_decided':
        if (!this.active.size) await this.hook({ hook_event_name: 'Stop' });
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
