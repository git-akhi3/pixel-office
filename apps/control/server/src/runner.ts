import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { systemPromptFor, type AgentDef } from './agents.js';
import type { Role } from './domain.js';
import { checkToolCall, type GuardContext } from './guard.js';

export type PermissionAnswer = 'allow_once' | 'allow_always' | 'deny';

export interface RunRequest {
  taskId: number;
  runId: number;
  role: Role;
  agent: AgentDef;
  prompt: string;
  cwd: string;
  guard: GuardContext;
  signal: AbortSignal;
  onEvent(type: string, payload: Record<string, unknown>): void;
  /** Called for commands not on the allow-list. Resolves when I decide on the board. */
  askPermission(subject: string, unmatched: string[], reason: string): Promise<PermissionAnswer>;
  /** Checks the final message against its handoff contract. A returned message is sent back once for a fix. */
  validate?(text: string): string | null;
}

export interface RunUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  thinking: number;
}

export interface RunOutcome {
  status: 'ok' | 'failed' | 'interrupted' | 'rate_limited';
  text: string;
  sessionId?: string;
  usage: RunUsage;
  error?: string;
  resetsAt?: number;
  durationMs: number;
}

export interface RateLimitSnapshot {
  fiveHour?: number;
  sevenDay?: number;
  resetsAt?: number;
  status?: string;
}

export interface AgentRunner {
  run(req: RunRequest): Promise<RunOutcome>;
  /** Sends a message to a running agent (phase 2: `steer:` from Slack). */
  steer(runId: number, text: string): boolean;
}

export const emptyUsage = (): RunUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 });

const RATE_LIMIT_TEXT = /rate.?limit|usage limit|limit reached/i;

/** Environment for agent sessions: nothing from the desktop app, only what Claude Code and the tools need. */
export function agentEnv(token: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (/^(CLAUDE|ANTHROPIC|MCP_|GH_|GITHUB_)/.test(k) || k === 'CLAUDECODE') continue;
    env[k] = v;
  }
  env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return env;
}

class InputQueue {
  private items: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;

  push(text: string): void {
    this.items.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null } as SDKUserMessage);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *stream(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      if (!this.items.length && !this.closed) await new Promise<void>((r) => (this.wake = r));
      const next = this.items.shift();
      if (next) yield next;
      else if (this.closed) return;
    }
  }
}

function shorten(value: unknown, max = 300): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export class SdkRunner implements AgentRunner {
  private live = new Map<number, InputQueue>();

  constructor(
    private token: string,
    private onRateLimit: (snapshot: RateLimitSnapshot) => void = () => {},
  ) {}

  steer(runId: number, text: string): boolean {
    const q = this.live.get(runId);
    if (!q) return false;
    q.push(text);
    return true;
  }

  async run(req: RunRequest): Promise<RunOutcome> {
    const started = Date.now();
    const input = new InputQueue();
    this.live.set(req.runId, input);
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    req.signal.addEventListener('abort', onAbort);

    const guard = req.guard;
    let sessionId: string | undefined;
    let text = '';
    let resetsAt: number | undefined;
    let rateLimited = false;
    let usage = emptyUsage();
    let corrections = 0;

    const decide = async (tool: string, toolInput: Record<string, unknown>) => {
      const d = checkToolCall(guard, tool, toolInput);
      if (d.decision !== 'ask') return d;
      req.onEvent('permission_request', { tool, subject: d.subject, reason: d.reason });
      const answer = await req.askPermission(d.subject, d.unmatched, d.reason);
      if (answer === 'allow_always') guard.allowlist.push(...d.unmatched);
      return answer === 'deny'
        ? ({ decision: 'deny', reason: 'The owner denied this command. Do not retry it or work around it. Change files with the Edit/Write tools; use only the repo\'s build, test and lint commands and read-only tools in the shell.' } as const)
        : ({ decision: 'allow' } as const);
    };

    input.push(req.prompt);
    const q = query({
      prompt: input.stream(),
      options: {
        model: req.agent.model,
        effort: req.agent.effort,
        cwd: req.cwd,
        tools: req.agent.tools,
        settingSources: [],
        permissionMode: 'default',
        maxTurns: req.agent.maxTurns,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPromptFor(req.agent) },
        env: agentEnv(this.token),
        abortController: abort,
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async (hookInput) => {
                  if (hookInput.hook_event_name !== 'PreToolUse') return {};
                  const d = checkToolCall(guard, hookInput.tool_name, (hookInput.tool_input ?? {}) as Record<string, unknown>);
                  if (d.decision === 'deny') req.onEvent('tool_denied', { tool: hookInput.tool_name, reason: d.reason });
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      permissionDecision: d.decision,
                      permissionDecisionReason: d.decision === 'allow' ? undefined : d.reason,
                    },
                  };
                },
              ],
            },
          ],
        },
        canUseTool: async (tool, toolInput) => {
          const d = await decide(tool, toolInput);
          return d.decision === 'allow'
            ? { behavior: 'allow', updatedInput: toolInput }
            : { behavior: 'deny', message: d.decision === 'deny' ? d.reason : 'not allowed' };
        },
      },
    });

    try {
      for await (const m of q as AsyncIterable<SDKMessage>) {
        switch (m.type) {
          case 'system':
            if (m.subtype === 'init') {
              sessionId = m.session_id;
              req.onEvent('session_start', { model: m.model, tools: m.tools });
            }
            break;
          case 'assistant': {
            if ((m as { error?: string }).error === 'rate_limit') rateLimited = true;
            for (const block of m.message.content) {
              if (block.type === 'text' && block.text.trim()) req.onEvent('text', { text: shorten(block.text, 1000) });
              if (block.type === 'tool_use') req.onEvent('tool', { tool: block.name, input: shorten(block.input) });
            }
            break;
          }
          case 'rate_limit_event': {
            const info = m.rate_limit_info as {
              status?: string;
              resetsAt?: number;
              unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }>;
            };
            const snapshot: RateLimitSnapshot = {
              status: info.status,
              resetsAt: info.resetsAt,
              fiveHour: info.unifiedWindows?.five_hour?.utilization,
              sevenDay: info.unifiedWindows?.seven_day?.utilization,
            };
            this.onRateLimit(snapshot);
            if (info.status === 'rejected') {
              rateLimited = true;
              resetsAt = info.resetsAt;
            }
            break;
          }
          case 'result': {
            // modelUsage is cumulative for the session: read the latest result, don't sum.
            usage = emptyUsage();
            for (const mu of Object.values(m.modelUsage ?? {})) {
              usage.input += mu.inputTokens ?? 0;
              usage.output += mu.outputTokens ?? 0;
              usage.cacheRead += mu.cacheReadInputTokens ?? 0;
              usage.cacheWrite += mu.cacheCreationInputTokens ?? 0;
              usage.thinking += (mu as { thinkingTokens?: number }).thinkingTokens ?? 0;
            }
            if (m.subtype === 'success') text = m.result;
            const ok = m.subtype === 'success' && !m.is_error && !rateLimited && !req.signal.aborted;
            const correction = ok && req.validate ? req.validate(text) : null;
            if (correction && corrections < 1) {
              corrections++;
              req.onEvent('correction', { reason: correction.slice(0, 300) });
              input.push(correction);
              continue;
            }
            if (correction) {
              input.close();
              return { status: 'failed', text, sessionId, usage, error: `output still invalid: ${correction.slice(0, 300)}`, durationMs: Date.now() - started };
            }
            input.close();
            const durationMs = Date.now() - started;
            if (req.signal.aborted) return { status: 'interrupted', text, sessionId, usage, durationMs };
            if (rateLimited) return { status: 'rate_limited', text, sessionId, usage, resetsAt, durationMs };
            if (m.subtype !== 'success' || m.is_error) {
              const error = m.subtype === 'success' ? m.result : m.subtype;
              return { status: 'failed', text, sessionId, usage, error, durationMs };
            }
            return { status: 'ok', text, sessionId, usage, durationMs };
          }
        }
      }
      const durationMs = Date.now() - started;
      if (req.signal.aborted) return { status: 'interrupted', text, sessionId, usage, durationMs };
      return { status: 'failed', text, sessionId, usage, error: 'session ended without a result', durationMs };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      const durationMs = Date.now() - started;
      if (req.signal.aborted) return { status: 'interrupted', text, sessionId, usage, durationMs };
      if (rateLimited || RATE_LIMIT_TEXT.test(error)) return { status: 'rate_limited', text, sessionId, usage, error, resetsAt, durationMs };
      return { status: 'failed', text, sessionId, usage, error, durationMs };
    } finally {
      input.close();
      req.signal.removeEventListener('abort', onAbort);
      this.live.delete(req.runId);
    }
  }
}
