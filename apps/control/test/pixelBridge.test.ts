import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { PixelBridge, projectDirName } from '../server/src/pixelBridge.js';

let pixelHome: string;
let projectsRoot: string;
let workspaceFile: string;
let posts: Array<{ url: string; auth: string | null; body: Record<string, unknown> }>;
let bridge: PixelBridge;
let rotated: string[];
const SESSION = '11111111-2222-3333-4444-555555555555';
const WORKSPACE = '/Users/me/.office/pixel';

let hang = false;
const fakeFetch = (async (url: string, init: RequestInit) => {
  if (hang) {
    return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('timeout'))));
  }
  posts.push({ url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) });
  return new Response('ok');
}) as unknown as typeof fetch;

/** Registers a running pixel server the way Pixel Agents does (servers/<pid>-<port>.json). */
function pixelRunning({ pid = process.pid, port = 3100, servesSpa = true, residents = ['designer', 'manager', 'coder', 'reviewer', 'tester'] } = {}) {
  mkdirSync(join(pixelHome, 'servers'), { recursive: true });
  rmSync(join(pixelHome, 'servers'), { recursive: true });
  mkdirSync(join(pixelHome, 'servers'));
  writeFileSync(join(pixelHome, 'servers', `${pid}-${port}.json`), JSON.stringify({ port, pid, token: 'secret-token', servesSpa, startedAt: Date.now() }));
  writeFileSync(join(pixelHome, 'layout.json'), JSON.stringify({ residents: residents.map((name) => ({ name, area: 'x' })) }));
}

const transcript = (session = SESSION) => join(projectsRoot, projectDirName(WORKSPACE), `${session}.jsonl`);
const records = (session = SESSION) =>
  existsSync(transcript(session))
    ? readFileSync(transcript(session), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const hooks = () => posts.map((p) => p.body.hook_event_name);
const toolUses = () => records().filter((r) => r.type === 'assistant');

beforeEach(() => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'office-pixel-')));
  pixelHome = join(dir, '.pixel-agents');
  projectsRoot = join(dir, 'projects');
  mkdirSync(pixelHome);
  workspaceFile = join(dir, 'pixel-workspace');
  writeFileSync(workspaceFile, `${WORKSPACE}\n`);
  posts = [];
  rotated = [];
  hang = false;
  bridge = new PixelBridge({
    pixelHome,
    projectsRoot,
    workspaceFile,
    sessionId: SESSION,
    fetchImpl: fakeFetch,
    hookTimeoutMs: 50,
    onRotate: (id) => rotated.push(id),
    taskTitle: () => 'Add greeting',
  });
});

describe('pixel bridge', () => {
  it('announces once (confirmed without the done chime), closes a stale turn, then shows steps as residents', async () => {
    pixelRunning();
    await bridge.enqueue('step_start', { role: 'coder' }, 3, 10);
    // SessionStart + PostToolUse adopt it; then the stale turn a crashed run may have left is closed.
    expect(hooks()).toEqual(['SessionStart', 'PostToolUse', 'Stop']);
    expect(posts[0]!.url).toBe('http://127.0.0.1:3100/api/hooks/claude');
    expect(posts[0]!.auth).toBe('Bearer secret-token');
    expect(posts[0]!.body).toMatchObject({ session_id: SESSION, cwd: WORKSPACE, transcript_path: transcript() });
    expect(toolUses()[0]).toMatchObject({
      message: { content: [{ type: 'tool_use', id: 'toolu_office_10', name: 'Agent', input: { subagent_type: 'coder', description: '#3 Add greeting' } }] },
    });
  });

  it('announces at startup, closing a stale turn before any task event', async () => {
    pixelRunning();
    await bridge.enqueue('startup', {}, 0, null);
    expect(hooks()).toEqual(['SessionStart', 'PostToolUse', 'Stop']);
    expect(records().map((r) => r.type)).toEqual(['system']);
  });

  it('goes idle in both places when the last step ends: transcript turn end and a Stop hook', async () => {
    pixelRunning();
    await bridge.enqueue('step_start', { role: 'coder' }, 3, 10);
    posts = [];
    await bridge.enqueue('step_end', { role: 'coder', status: 'ok' }, 3, 10);
    expect(records().slice(-2).map((r) => r.type)).toEqual(['user', 'system']);
    expect(hooks()).toEqual(['Stop']);
  });

  it('keeps other steps working when one of two ends', async () => {
    pixelRunning();
    await bridge.enqueue('step_start', { role: 'coder' }, 3, 10);
    await bridge.enqueue('step_start', { role: 'tester' }, 4, 11);
    posts = [];
    await bridge.enqueue('step_end', { role: 'coder' }, 3, 10);
    expect(records().at(-1).type).toBe('user');
    expect(hooks()).toEqual([]);
  });

  it('handles events in order and announces once, even when they arrive together', async () => {
    pixelRunning();
    await Promise.all([bridge.enqueue('step_start', { role: 'coder' }, 3, 10), bridge.enqueue('step_end', { role: 'coder' }, 3, 10)]);
    expect(hooks().filter((h) => h === 'SessionStart')).toHaveLength(1);
    const types = records().map((r) => r.type);
    expect(types.indexOf('assistant')).toBeLessThan(types.indexOf('user')); // tool_use before tool_result
  });

  it('announces again when the pixel server restarts (new pid)', async () => {
    pixelRunning();
    await bridge.enqueue('step_start', { role: 'coder' }, 3, 10);
    pixelRunning({ pid: process.ppid });
    posts = [];
    await bridge.enqueue('step_start', { role: 'tester' }, 4, 11);
    expect(hooks()).toEqual(['SessionStart', 'PostToolUse']);
  });

  it('uses the registered server that serves the office scene, not an embedded one', async () => {
    pixelRunning({ servesSpa: false });
    await bridge.enqueue('step_start', { role: 'coder' }, 3, 10);
    expect(posts).toHaveLength(0);
    expect(bridge.server()).toBeNull();
  });

  it('times out on a hung pixel server and recovers when it answers again', async () => {
    pixelRunning();
    hang = true;
    await bridge.enqueue('step_start', { role: 'coder' }, 3, 10); // resolves after the 50 ms timeout
    hang = false;
    await bridge.enqueue('step_start', { role: 'coder' }, 3, 12);
    expect(hooks().slice(0, 2)).toEqual(['SessionStart', 'PostToolUse']);
  });

  it('shows the waiting bubble for a gate and clears it after the decision when idle', async () => {
    pixelRunning();
    await bridge.enqueue('gate', { kind: 'plan', status: 'pending' }, 3, null);
    expect(posts.at(-1)!.body).toMatchObject({ hook_event_name: 'Notification', notification_type: 'permission_prompt' });
    await bridge.enqueue('gate_decided', { kind: 'plan', decision: 'approve' }, 3, null);
    expect(hooks().at(-1)).toBe('Stop');
  });

  it('puts the architect at the designer desk in layouts without an architect', async () => {
    pixelRunning();
    await bridge.enqueue('step_start', { role: 'architect' }, 3, 11);
    expect(toolUses().at(-1).message.content[0].input.subagent_type).toBe('designer');
    pixelRunning({ residents: ['architect', 'designer'] });
    await bridge.enqueue('step_start', { role: 'architect' }, 4, 12);
    expect(toolUses().at(-1).message.content[0].input.subagent_type).toBe('architect');
  });

  it('has Captain America play the all-rounder, or the coder in layouts without him', async () => {
    pixelRunning({ residents: ['manager', 'coder', 'captain'] });
    await bridge.enqueue('step_start', { role: 'all-rounder' }, 3, 11);
    expect(toolUses().at(-1).message.content[0].input.subagent_type).toBe('captain');
    pixelRunning({ residents: ['manager', 'coder'] });
    await bridge.enqueue('step_start', { role: 'all-rounder' }, 4, 12);
    expect(toolUses().at(-1).message.content[0].input.subagent_type).toBe('coder');
  });

  it('rotates a large transcript to a new session between steps', async () => {
    bridge = new PixelBridge({ pixelHome, projectsRoot, workspaceFile, sessionId: SESSION, fetchImpl: fakeFetch, maxTranscriptBytes: 200, onRotate: (id) => rotated.push(id), taskTitle: () => 'x' });
    pixelRunning();
    await bridge.enqueue('step_start', { role: 'coder' }, 3, 10);
    await bridge.enqueue('step_end', { role: 'coder' }, 3, 10);
    posts = [];
    await bridge.enqueue('step_start', { role: 'coder' }, 3, 11);
    expect(rotated).toHaveLength(1);
    expect(bridge.sessionId).toBe(rotated[0]);
    expect(existsSync(transcript())).toBe(false); // old file removed
    expect(posts[0]!.body).toMatchObject({ hook_event_name: 'SessionEnd', session_id: SESSION });
    expect(hooks()).toContain('SessionStart');
    expect(records(rotated[0])[0]).toBeTruthy();
  });

  it('does nothing while the pixel office is not running or never started from start.sh', async () => {
    await bridge.enqueue('step_start', { role: 'coder' }, 3, 10);
    expect(posts).toHaveLength(0);
    pixelRunning();
    rmSync(workspaceFile);
    await bridge.enqueue('step_start', { role: 'coder' }, 3, 10);
    expect(posts).toHaveLength(0);
  });
});
