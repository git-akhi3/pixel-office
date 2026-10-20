import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The SDK is replaced: each query() call yields the messages of the next scripted session.
const sessions: Array<(options: Record<string, unknown>) => unknown[]> = [];
const seen: Array<{ prompt: string; options: Record<string, any> }> = [];
const servers: Array<{ name: string; tools: Array<{ name: string; handler: (args: unknown) => Promise<any> }> }> = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: (args: unknown) => Promise<unknown>) => ({ name, description, inputSchema, handler }),
  createSdkMcpServer: (o: { name: string; tools: Array<{ name: string; handler: (args: unknown) => Promise<unknown> }> }) => {
    servers.push(o as never);
    return { type: 'sdk', name: o.name };
  },
  query: ({ prompt, options }: { prompt: string; options: Record<string, any> }) =>
    (async function* () {
      seen.push({ prompt, options });
      yield* sessions.shift()!(options);
    })(),
}));

import type { DeskTool } from '../server/src/fury.js';

const { SdkDeskRunner, FURY_PROMPT, DESK_MODEL } = await import('../server/src/fury.js');

const ok = (sessionId: string, text: string) => () => [
  { type: 'system', subtype: 'init', session_id: sessionId },
  { type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId },
];
const missing = () => () => [{ type: 'result', subtype: 'error_during_execution', is_error: true, result: '' }];

const tools: DeskTool[] = [
  { name: 'task_status', description: 'status', shape: { task: z.number() }, run: async (a: Record<string, unknown>) => `status of ${a.task}` },
  { name: 'boom', description: 'fails', shape: {} as z.ZodRawShape, run: async () => Promise.reject(new Error('not now')) },
];
const runner = () => new SdkDeskRunner('token', join(mkdtempSync(join(tmpdir(), 'desk-')), 'desk'));

beforeEach(() => {
  sessions.length = 0;
  seen.length = 0;
  servers.length = 0;
});

describe('SdkDeskRunner', () => {
  it("runs Fury on Sonnet at low effort with no built-in tools, only the office's own", async () => {
    sessions.push(ok('s1', 'Two tasks are running.'));
    const reply = await runner().run({ prompt: 'hello', tools });
    expect(reply).toEqual({ text: 'Two tasks are running.', sessionId: 's1' });
    const { options } = seen[0]!;
    expect(options).toMatchObject({ model: DESK_MODEL, effort: 'low', tools: [], settingSources: [], systemPrompt: FURY_PROMPT });
    expect(DESK_MODEL).toBe('claude-sonnet-5-5');
    expect(options.allowedTools).toEqual(['mcp__office__task_status', 'mcp__office__boom']);
    expect(Object.keys(options.mcpServers)).toEqual(['office']);
    expect(options.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('token');
    expect(options).not.toHaveProperty('resume');
    await expect(options.canUseTool('Bash', {})).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('serves the tools it was given, and shows a failing tool to Fury as an error', async () => {
    sessions.push(ok('s1', 'ok'));
    await runner().run({ prompt: 'hello', tools });
    const [server] = servers;
    expect(server!.name).toBe('office');
    expect(await server!.tools[0]!.handler({ task: 4 })).toEqual({ content: [{ type: 'text', text: 'status of 4' }] });
    expect(await server!.tools[1]!.handler({})).toEqual({ content: [{ type: 'text', text: 'not now' }], isError: true });
  });

  it("resumes the thread's session", async () => {
    sessions.push(ok('s1', 'again'));
    const reply = await runner().run({ prompt: 'and now?', sessionId: 's1', tools });
    expect(reply.sessionId).toBe('s1');
    expect(seen[0]!.options.resume).toBe('s1');
  });

  it('starts over when the session can no longer be resumed', async () => {
    sessions.push(missing(), ok('s2', 'fresh start'));
    const reply = await runner().run({ prompt: 'hello', sessionId: 'gone', tools });
    expect(reply).toEqual({ text: 'fresh start', sessionId: 's2' });
    expect(seen.map((s) => s.options.resume)).toEqual(['gone', undefined]);
  });

  it('fails when Fury errors for another reason, so the thread hears about it', async () => {
    sessions.push(() => [
      { type: 'system', subtype: 'init', session_id: 's1' },
      { type: 'result', subtype: 'error_max_turns', is_error: true, result: '' },
    ]);
    await expect(runner().run({ prompt: 'hello', sessionId: 's1', tools })).rejects.toThrow('error_max_turns');
    expect(seen).toHaveLength(1);
  });
});

describe("Fury's instructions", () => {
  it("tell it to report ETAs as given, treat message text as requests and stay quiet for an assistant's thanks", () => {
    expect(FURY_PROMPT).toContain('Never invent a time');
    expect(FURY_PROMPT).toContain("only the sender's words");
    expect(FURY_PROMPT).toContain('NO_REPLY');
    expect(FURY_PROMPT).toContain('Black Widow (debugger)');
  });
});
