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
const SESSION = '11111111-2222-3333-4444-555555555555';
const WORKSPACE = '/Users/me/.office/pixel';

const fakeFetch = (async (url: string, init: RequestInit) => {
  posts.push({ url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) });
  return new Response('ok');
}) as unknown as typeof fetch;

function pixelRunning(residents = ['designer', 'manager', 'coder', 'reviewer', 'tester']) {
  writeFileSync(join(pixelHome, 'server.json'), JSON.stringify({ port: 3100, pid: process.pid, token: 'secret-token' }));
  writeFileSync(join(pixelHome, 'layout.json'), JSON.stringify({ residents: residents.map((name) => ({ name, area: 'x' })) }));
}

const transcript = () => join(projectsRoot, projectDirName(WORKSPACE), `${SESSION}.jsonl`);
const records = () =>
  existsSync(transcript())
    ? readFileSync(transcript(), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const hooks = () => posts.map((p) => p.body.hook_event_name);

beforeEach(() => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'office-pixel-')));
  pixelHome = join(dir, '.pixel-agents');
  projectsRoot = join(dir, 'projects');
  mkdirSync(pixelHome);
  workspaceFile = join(dir, 'pixel-workspace');
  writeFileSync(workspaceFile, `${WORKSPACE}\n`);
  posts = [];
  bridge = new PixelBridge({ pixelHome, projectsRoot, workspaceFile, sessionId: SESSION, fetchImpl: fakeFetch, taskTitle: () => 'Add greeting' });
});

describe('pixel bridge', () => {
  it('announces the office once with its transcript, then shows each step as its resident at work', async () => {
    pixelRunning();
    await bridge.onEvent('step_start', { role: 'coder' }, 3, 10);
    expect(hooks()).toEqual(['SessionStart', 'Stop']);
    expect(posts[0]!.url).toBe('http://127.0.0.1:3100/api/hooks/claude');
    expect(posts[0]!.auth).toBe('Bearer secret-token');
    expect(posts[0]!.body).toMatchObject({ session_id: SESSION, cwd: WORKSPACE, transcript_path: transcript() });

    const [start] = records();
    expect(start).toMatchObject({
      type: 'assistant',
      sessionId: SESSION,
      message: { content: [{ type: 'tool_use', id: 'toolu_office_10', name: 'Agent', input: { subagent_type: 'coder', description: '#3 Add greeting' } }] },
    });

    await bridge.onEvent('step_end', { role: 'coder', status: 'ok' }, 3, 10);
    const [, result, turnEnd] = records();
    expect(result).toMatchObject({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_office_10' }] } });
    expect(turnEnd).toMatchObject({ type: 'system', subtype: 'turn_duration' }); // nothing else running: idle
    expect(hooks()).toEqual(['SessionStart', 'Stop']); // announced only once
  });

  it('puts the architect at the designer desk in layouts without an architect', async () => {
    pixelRunning();
    await bridge.onEvent('step_start', { role: 'architect' }, 3, 11);
    expect(records().at(-1).message.content[0].input.subagent_type).toBe('designer');
    pixelRunning(['architect', 'designer']);
    await bridge.onEvent('step_start', { role: 'architect' }, 4, 12);
    expect(records().at(-1).message.content[0].input.subagent_type).toBe('architect');
  });

  it('keeps other steps working when one of two ends', async () => {
    pixelRunning();
    await bridge.onEvent('step_start', { role: 'coder' }, 3, 10);
    await bridge.onEvent('step_start', { role: 'tester' }, 4, 11);
    await bridge.onEvent('step_end', { role: 'coder' }, 3, 10);
    expect(records().map((r) => r.type)).toEqual(['assistant', 'assistant', 'user']); // no turn end yet
  });

  it('shows the waiting bubble when a gate needs me', async () => {
    pixelRunning();
    await bridge.onEvent('gate', { kind: 'plan', status: 'pending' }, 3, null);
    expect(posts.at(-1)!.body).toMatchObject({ hook_event_name: 'Notification', notification_type: 'permission_prompt' });
  });

  it('does nothing while the pixel office is not running, and announces again when it is back', async () => {
    await bridge.onEvent('step_start', { role: 'coder' }, 3, 10);
    writeFileSync(join(pixelHome, 'server.json'), JSON.stringify({ port: 3100, pid: 999_999_999, token: 't' })); // stale
    await bridge.onEvent('step_start', { role: 'coder' }, 3, 10);
    expect(posts).toHaveLength(0);
    expect(records()).toHaveLength(0);
    pixelRunning();
    await bridge.onEvent('step_start', { role: 'coder' }, 3, 10);
    expect(hooks()).toEqual(['SessionStart', 'Stop']);
  });

  it('stays quiet without a workspace file (pixel office not started from start.sh)', async () => {
    pixelRunning();
    rmSync(workspaceFile);
    await bridge.onEvent('step_start', { role: 'coder' }, 3, 10);
    expect(posts).toHaveLength(0);
  });
});
