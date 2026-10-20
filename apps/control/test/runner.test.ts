import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The SDK's query() is replaced by a script per call: each call yields the messages of one session.
const sessions: Array<(options: Record<string, unknown>) => unknown[]> = [];
const seen: Array<{ options: Record<string, unknown>; firstMessage: string }> = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt, options }: { prompt: AsyncIterable<{ message: { content: string } }>; options: Record<string, unknown> }) =>
    (async function* () {
      const first = await prompt[Symbol.asyncIterator]().next();
      seen.push({ options, firstMessage: first.value?.message.content ?? '' });
      yield* sessions.shift()!(options);
    })(),
}));

const { SdkRunner } = await import('../server/src/runner.js');
const { loadAgents } = await import('../server/src/agents.js');

const appDir = join(import.meta.dirname, '..');
const agents = loadAgents(join(appDir, 'agents'), join(appDir, 'skills'));

const ok = (sessionId: string, text: string) => () => [
  { type: 'system', subtype: 'init', session_id: sessionId, model: 'm', tools: [] },
  { type: 'result', subtype: 'success', is_error: false, result: text, modelUsage: {} },
];
const missing = () => () => [{ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', modelUsage: {} }];

function request(resume?: { sessionId: string; prompt: string; usageSoFar?: { input: number; output: number; cacheRead: number; cacheWrite: number; thinking: number } }) {
  const events: Array<[string, Record<string, unknown>]> = [];
  return {
    events,
    req: {
      taskId: 1,
      runId: 7,
      role: 'all-rounder' as const,
      agent: agents['all-rounder'],
      prompt: 'FULL PROMPT',
      cwd: '/tmp',
      guard: { worktree: '/tmp', write: 'all' as const, testGlobs: [], allowlist: [] },
      signal: new AbortController().signal,
      onEvent: (type: string, payload: Record<string, unknown>) => events.push([type, payload]),
      askPermission: async () => 'deny' as const,
      ...(resume ? { resume } : {}),
    },
  };
}

beforeEach(() => {
  sessions.length = 0;
  seen.length = 0;
});

describe('SdkRunner resume', () => {
  it('continues the earlier session with only the new message', async () => {
    sessions.push(ok('s1', 'fixed'));
    const { req } = request({ sessionId: 's1', prompt: 'FIX THIS' });
    const out = await new SdkRunner('token').run(req);
    expect(out).toMatchObject({ status: 'ok', text: 'fixed', sessionId: 's1' });
    expect(seen).toEqual([{ options: expect.objectContaining({ resume: 's1' }), firstMessage: 'FIX THIS' }]);
  });

  it('starts fresh with the full prompt when the session cannot be resumed', async () => {
    sessions.push(missing(), ok('s2', 'done'));
    const { req, events } = request({ sessionId: 'gone', prompt: 'FIX THIS' });
    const out = await new SdkRunner('token').run(req);
    expect(out).toMatchObject({ status: 'ok', text: 'done', sessionId: 's2' });
    expect(seen.map((s) => [s.options.resume, s.firstMessage])).toEqual([
      ['gone', 'FIX THIS'],
      [undefined, 'FULL PROMPT'],
    ]);
    expect(events.map(([type]) => type)).toContain('resume_failed');
  });

  it('starts fresh when the SDK throws on a session it cannot find', async () => {
    sessions.push(
      () => {
        throw new Error('No conversation found with session ID: gone');
      },
      ok('s3', 'done'),
    );
    const { req } = request({ sessionId: 'gone', prompt: 'FIX THIS' });
    const out = await new SdkRunner('token').run(req);
    expect(out).toMatchObject({ status: 'ok', sessionId: 's3' });
    expect(seen.at(-1)!.firstMessage).toBe('FULL PROMPT');
  });

  it('counts only its own tokens when it continues a session', async () => {
    sessions.push(() => [
      { type: 'system', subtype: 'init', session_id: 's1', model: 'm', tools: [] },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'fixed',
        // The SDK reports the session's whole history, earlier runs included.
        modelUsage: { m: { inputTokens: 300, outputTokens: 80, cacheReadInputTokens: 9000, cacheCreationInputTokens: 500 } },
      },
    ]);
    const { req } = request({ sessionId: 's1', prompt: 'FIX THIS', usageSoFar: { input: 200, output: 50, cacheRead: 4000, cacheWrite: 400, thinking: 0 } });
    const out = await new SdkRunner('token').run(req);
    expect(out.usage).toEqual({ input: 100, output: 30, cacheRead: 5000, cacheWrite: 100, thinking: 0 });
  });

  it('does not start over when a resumed session fails after it started', async () => {
    sessions.push(() => [
      { type: 'system', subtype: 'init', session_id: 's1', model: 'm', tools: [] },
      { type: 'result', subtype: 'error_max_turns', is_error: true, result: '', modelUsage: {} },
    ]);
    const { req } = request({ sessionId: 's1', prompt: 'FIX THIS' });
    const out = await new SdkRunner('token').run(req);
    expect(out.status).toBe('failed');
    expect(seen).toHaveLength(1);
  });
});
