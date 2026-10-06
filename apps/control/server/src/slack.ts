// The Slack side of the office: DM the bot to start a task, then follow it in that message's thread.
//
// One thread per task, with a single status message edited about every 10 seconds. New messages
// only for gates, milestones and alerts. Everything the owner types or taps goes through the same
// Pipeline calls the board uses. Only the owner's messages and button taps are honoured.

import { App, LogLevel } from '@slack/bolt';
import { and, eq } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { schema } from './db/index.js';
import type { Gate, Task } from './db/schema.js';
import { AGENT_STEPS, boardColumn, isAgentStep, TERMINAL_STATUSES, type GateDecision } from './domain.js';
import type { BusMessage, EventBus } from './events.js';
import type { TaskDocs } from './handoffs.js';
import type { Pipeline } from './pipeline.js';
import { listRepos } from './repos.js';
import type { SlackConfig } from './config.js';

/** The slice of Slack's Web API the bridge uses (so tests can fake it). */
export interface SlackApi {
  postMessage(args: { channel: string; text: string; thread_ts?: string; blocks?: unknown[] }): Promise<{ ts?: string }>;
  updateMessage(args: { channel: string; ts: string; text: string; blocks?: unknown[] }): Promise<unknown>;
  openDm(userId: string): Promise<string>;
}

export interface SlackBridgeDeps {
  db: Db;
  bus: EventBus;
  pipeline: Pipeline;
  docs: TaskDocs;
  ownerId: string;
  /** Where "Open in office" links point. */
  publicUrl: string;
  api: SlackApi;
  now?: () => number;
}

const STATUS_REFRESH_MS = 10_000;
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
const MAX_SECTION = 2800;

/** Slack mrkdwn treats & < > as markup. */
export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clip(text: string, max = MAX_SECTION): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n);
}

export const HELP = [
  '*Start a task:* DM me `<repo>: what to build or fix` (the repo name is optional when only one is registered), or paste a GitHub PR link to review it.',
  '*In a task thread:* `status` · `pause` / `stop` · `resume` · `steer: <note to the agent>` · `replan: <why>` · `approve` · `reject: <what to change>` · `discard` · `done`',
].join('\n');

export class SlackBridge {
  private dm: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** The owner's DM message that is creating a task right now: it becomes that task's thread. */
  private claim: { channel: string; ts: string } | null = null;
  private stepStartedAt = new Map<number, number>();
  private lastStatusText = new Map<number, string>();
  private lastStatus = new Map<number, string>();
  private threadLocks = new Map<number, Promise<unknown>>();

  constructor(private deps: SlackBridgeDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async start(): Promise<void> {
    this.dm = await this.deps.api.openDm(this.deps.ownerId);
    this.unsubscribe = this.deps.bus.subscribe((m) => this.onBus(m));
    this.timer = setInterval(() => void this.refreshStatuses(), STATUS_REFRESH_MS);
    this.timer.unref();
  }

  stop(): void {
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
  }

  async announce(): Promise<void> {
    await this.say(`Pixel Office is online. Board: ${this.deps.publicUrl}\n${HELP}`);
  }

  // ------------------------------------------------------------ incoming: messages

  /** A message the owner sent in the bot's DM. */
  async onMessage(msg: { user?: string; channel: string; ts: string; thread_ts?: string; text?: string; subtype?: string; bot_id?: string }): Promise<void> {
    if (msg.user !== this.deps.ownerId || msg.subtype || msg.bot_id) return;
    const text = (msg.text ?? '').trim();
    if (!text) return;
    try {
      if (msg.thread_ts && msg.thread_ts !== msg.ts) await this.onThreadMessage(msg.channel, msg.thread_ts, text);
      else await this.onNewTask(msg.channel, msg.ts, text);
    } catch (e) {
      await this.reply(msg.channel, msg.thread_ts ?? msg.ts, `:warning: ${esc((e as Error).message)}`);
    }
  }

  private async onNewTask(channel: string, ts: string, text: string): Promise<void> {
    if (/^(help|\?)$/i.test(text)) return void (await this.reply(channel, ts, HELP));
    const pr = text.match(PR_URL)?.[0];
    this.claim = { channel, ts };
    try {
      if (pr) {
        const task = await this.deps.pipeline.createReviewTask(pr);
        await this.reply(channel, ts, `Reviewing PR as task #${task.id}. I'll post the draft here when it's ready.`);
        return;
      }
      const { repoId, input, error } = this.parseTask(text);
      if (error) return void (await this.reply(channel, ts, error));
      const task = this.deps.pipeline.createTask({ repoId: repoId!, input: input! });
      await this.reply(channel, ts, `Task #${task.id} queued. Updates will appear in this thread.`);
    } finally {
      this.claim = null;
    }
  }

  private parseTask(text: string): { repoId?: number; input?: string; error?: string } {
    const repos = listRepos(this.deps.db);
    if (repos.length === 0) return { error: 'No repos registered yet. Add one on the board under Repos first.' };
    const m = text.match(/^([\w.-]+)\s*:\s*([\s\S]+)$/);
    const named = m && repos.find((r) => r.name.toLowerCase() === m[1]!.toLowerCase());
    if (named) return { repoId: named.id, input: m![2]!.trim() };
    if (repos.length === 1) return { repoId: repos[0]!.id, input: text };
    return { error: `Which repo? Start with \`<repo>: ...\`. Registered: ${repos.map((r) => `\`${esc(r.name)}\``).join(', ')}.` };
  }

  private taskForThread(channel: string, threadTs: string): Task | undefined {
    return this.deps.db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.slackChannel, channel), eq(schema.tasks.slackThreadTs, threadTs)))
      .get();
  }

  private async onThreadMessage(channel: string, threadTs: string, text: string): Promise<void> {
    const task = this.taskForThread(channel, threadTs);
    if (!task) return void (await this.reply(channel, threadTs, 'This thread has no task. Start one with a new message.'));
    const say = (t: string) => this.reply(channel, threadTs, t);
    const { pipeline } = this.deps;
    const [, word = '', rest = ''] = text.match(/^(\w+)\s*:?\s*([\s\S]*)$/) ?? [];
    switch (word.toLowerCase()) {
      case 'status': {
        const t = pipeline.getTask(task.id);
        return void (await say(this.statusText(t, false)));
      }
      case 'pause':
      case 'stop':
        await pipeline.action(task.id, 'stop');
        return void (await say('Stopped. The worktree is kept; say `resume` to continue.'));
      case 'resume':
        await pipeline.action(task.id, 'resume');
        return void (await say('Resumed.'));
      case 'discard':
        await pipeline.action(task.id, 'discard');
        return void (await say('Discarded.'));
      case 'done':
        await pipeline.action(task.id, 'done');
        return void (await say('Marked done.'));
      case 'steer': {
        if (!rest.trim()) return void (await say('Say what: `steer: <note>`.'));
        const where = pipeline.steer(task.id, rest.trim());
        return void (await say(where === 'live' ? 'Sent to the running agent.' : 'Saved for the next step.'));
      }
      case 'replan': {
        if (!rest.trim()) return void (await say('Say why: `replan: <reason>`.'));
        pipeline.replanNow(task.id, rest.trim());
        return void (await say('Sent back to the architect for a new plan.'));
      }
      case 'approve':
      case 'reject': {
        const gate = this.approvalGate(task.id);
        if (!gate) return void (await say('Nothing is waiting for approval.'));
        if (word.toLowerCase() === 'reject' && !rest.trim()) return void (await say('Say what to change: `reject: <what to change>`.'));
        await pipeline.decideGate(gate.id, word.toLowerCase() as GateDecision, rest.trim() || undefined);
        return;
      }
      default:
        return void (await say(HELP));
    }
  }

  /** The pending plan, push or review gate of a task (command gates are answered with their buttons). */
  private approvalGate(taskId: number): Gate | undefined {
    return this.deps.pipeline.pendingGates(taskId).find((g) => g.kind !== 'command');
  }

  // ------------------------------------------------------------ incoming: buttons

  /** A tap on one of the gate buttons. Returns a short note to show when it can't be done. */
  async onButton(user: string | undefined, actionId: string): Promise<string | null> {
    if (user !== this.deps.ownerId) return null;
    const m = actionId.match(/^office_gate:(\d+):(approve|reject|allow_once|allow_always|deny)$/);
    if (!m) return null;
    const gateId = Number(m[1]);
    const decision = m[2] as GateDecision;
    const gate = this.deps.db.select().from(schema.gates).where(eq(schema.gates.id, gateId)).get();
    if (!gate) return 'That gate no longer exists.';
    if (decision === 'reject') {
      const task = this.deps.pipeline.getTask(gate.taskId);
      await this.say(`To reject, reply in the thread with \`reject: <what to change>\`.`, task);
      return null;
    }
    try {
      await this.deps.pipeline.decideGate(gateId, decision);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  // ------------------------------------------------------------ outgoing

  private onBus(msg: BusMessage): void {
    void this.handle(msg).catch((e) => console.warn(`Slack: ${(e as Error).message}`));
  }

  private async handle(msg: BusMessage): Promise<void> {
    if (msg.type === 'task') return this.onTask(msg.task);
    const { event } = msg;
    if (event.taskId === null) return;
    const taskId = event.taskId;
    if (event.type === 'created' && this.claim) {
      // This task was started from a DM: that message is its thread.
      this.deps.db
        .update(schema.tasks)
        .set({ slackChannel: this.claim.channel, slackThreadTs: this.claim.ts })
        .where(eq(schema.tasks.id, taskId))
        .run();
      this.claim = null;
      return;
    }
    const task = this.deps.pipeline.getTask(taskId);
    if (event.type === 'created') return this.renderStatus(task);
    switch (event.type) {
      case 'step_start':
        this.stepStartedAt.set(taskId, this.now());
        return this.renderStatus(task);
      case 'step_end':
        return this.renderStatus(task);
      case 'gate':
        return this.onGate(task, event.payload as { gateId: number; kind: Gate['kind']; subject: string | null; status: string; auto: boolean });
      case 'gate_decided':
        return this.onGateDecided(task, event.payload as { gateId: number; decision: string; comment?: string });
      case 'alert':
        return void (await this.say(`:rotating_light: ${esc(String(event.payload.message ?? ''))}`, task));
      case 'pr_opened':
        return void (await this.say(`:rocket: Draft PR opened: ${String(event.payload.url)}`, task));
      case 'pr_merged':
        return void (await this.say(`:tada: PR merged: ${String(event.payload.url)}`, task));
      case 'review_posted':
        return void (await this.say(`:memo: Review posted: ${String(event.payload.url)}`, task));
      case 'worktree':
        return;
      default:
        return;
    }
  }

  private async onTask(task: Task): Promise<void> {
    const previous = this.lastStatus.get(task.id);
    this.lastStatus.set(task.id, task.status);
    if (previous === task.status) return;
    if (TERMINAL_STATUSES.includes(task.status)) {
      const word = task.status === 'done' ? ':white_check_mark: Done' : task.status === 'failed' ? ':x: Failed' : ':wastebasket: Discarded';
      await this.renderStatus(task);
      if (previous) await this.say(`${word}.${task.statusNote ? ` ${esc(task.statusNote)}` : ''}`, task);
    } else if (previous && ['paused', 'blocked', 'stopped'].includes(task.status)) {
      const word = task.status === 'stopped' ? 'Stopped' : task.status === 'paused' ? 'Paused' : 'Blocked';
      await this.renderStatus(task);
      await this.say(`:double_vertical_bar: ${word}.${task.statusNote ? ` ${esc(task.statusNote)}` : ''} Say \`resume\` when ready.`, task);
    } else if (previous) {
      await this.renderStatus(task);
    }
  }

  private async onGate(task: Task, g: { gateId: number; kind: Gate['kind']; subject: string | null; status: string; auto: boolean }): Promise<void> {
    if (g.status !== 'pending') {
      if (g.auto) await this.say(`:white_check_mark: ${g.kind === 'push' ? 'Push' : 'Gate'} auto-approved.`, task);
      return;
    }
    const link = `${this.deps.publicUrl}/#/task/${task.id}`;
    let heading: string;
    let body = '';
    let buttons: unknown[];
    if (g.kind === 'command') {
      heading = ':lock: *An agent wants to run a command*';
      body = `\`\`\`${clip(g.subject ?? '', 1500).replace(/```/g, "'''")}\`\`\``;
      buttons = [this.button(g.gateId, 'allow_once', 'Allow once', 'primary'), this.button(g.gateId, 'allow_always', 'Always for this repo'), this.button(g.gateId, 'deny', 'Deny', 'danger')];
    } else {
      const label = g.kind === 'plan' ? 'Plan ready for approval' : g.kind === 'push' ? 'Ready to push and open a draft PR' : 'Draft review ready to post';
      heading = `:raised_hand: *${label}*`;
      const doc = g.kind === 'plan' ? this.deps.docs.latest(task.id, 'plan') : g.kind === 'review_post' ? this.deps.docs.latest(task.id, 'pr-review') : null;
      if (doc) body = esc(clip(doc.replace(/^---[\s\S]*?---\s*/, ''), 2000));
      buttons = [this.button(g.gateId, 'approve', g.kind === 'review_post' ? 'Post review' : 'Approve', 'primary'), this.button(g.gateId, 'reject', 'Reject…', 'danger')];
    }
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: `${heading}\n*#${task.id}* ${esc(task.title)}` } },
      ...(body ? [{ type: 'section', text: { type: 'mrkdwn', text: body } }] : []),
      { type: 'actions', elements: [...buttons, { type: 'button', text: { type: 'plain_text', text: 'Open in office' }, url: link }] },
    ];
    const ts = await this.say(`#${task.id} needs you: ${g.kind} gate`, task, blocks);
    if (ts) this.deps.db.update(schema.gates).set({ slackTs: ts }).where(eq(schema.gates.id, g.gateId)).run();
  }

  private async onGateDecided(task: Task, d: { gateId: number; decision: string; comment?: string }): Promise<void> {
    const gate = this.deps.db.select().from(schema.gates).where(eq(schema.gates.id, d.gateId)).get();
    if (!gate?.slackTs || !task.slackChannel) return;
    const verb = { approve: 'Approved', reject: 'Rejected', allow_once: 'Allowed once', allow_always: 'Always allowed for this repo', deny: 'Denied' }[d.decision] ?? d.decision;
    const text = `${verb}${d.comment ? `: ${d.comment}` : ''} (${gate.kind})`;
    await this.deps.api.updateMessage({
      channel: task.slackChannel,
      ts: gate.slackTs,
      text,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${d.decision === 'approve' || d.decision.startsWith('allow') ? ':white_check_mark:' : ':no_entry:'} *${esc(verb)}* · ${esc(gate.kind)} gate · #${task.id} ${esc(task.title)}${d.comment ? `\n>${esc(clip(d.comment, 500))}` : ''}` } }],
    });
  }

  private button(gateId: number, decision: GateDecision, label: string, style?: 'primary' | 'danger') {
    return { type: 'button', action_id: `office_gate:${gateId}:${decision}`, text: { type: 'plain_text', text: label }, ...(style ? { style } : {}) };
  }

  // ------------------------------------------------------------ status message

  private statusText(task: Task, live = true): string {
    const column = boardColumn(task.status);
    const running = isAgentStep(task.status);
    const agent = running ? AGENT_STEPS[task.status] : null;
    const started = this.stepStartedAt.get(task.id) ?? task.updatedAt;
    const parts = [`*#${task.id}* ${esc(task.title)}`, `${esc(task.status.replace(/_/g, ' '))} (${column})`];
    if (agent) parts.push(agent);
    if (running) parts.push(duration(this.now() - started));
    parts.push(`${tokens(this.deps.pipeline.tokensUsed(task.id))} tokens`);
    if (task.statusNote) parts.push(esc(clip(task.statusNote, 200)));
    if (task.prUrl) parts.push(task.prUrl);
    return parts.join(' · ') + (live ? '' : `\n<${this.deps.publicUrl}/#/task/${task.id}|Open in office>`);
  }

  /** Posts or edits the task's single status message. */
  private async renderStatus(task: Task): Promise<void> {
    await this.withThread(task.id, async () => {
      const fresh = this.deps.pipeline.getTask(task.id);
      const thread = await this.ensureThread(fresh);
      if (!thread) return;
      const text = this.statusText(fresh);
      if (this.lastStatusText.get(fresh.id) === text && fresh.slackStatusTs) return;
      if (fresh.slackStatusTs) {
        await this.deps.api.updateMessage({ channel: thread.channel, ts: fresh.slackStatusTs, text });
      } else {
        const res = await this.deps.api.postMessage({ channel: thread.channel, thread_ts: thread.ts, text });
        if (res.ts) this.deps.db.update(schema.tasks).set({ slackStatusTs: res.ts }).where(eq(schema.tasks.id, fresh.id)).run();
      }
      this.lastStatusText.set(fresh.id, text);
    });
  }

  /** Refreshes the elapsed time of tasks that are working right now. */
  async refreshStatuses(): Promise<void> {
    const rows = this.deps.db.select().from(schema.tasks).all().filter((t) => isAgentStep(t.status) && t.slackStatusTs);
    for (const t of rows) await this.renderStatus(t).catch((e) => console.warn(`Slack: ${(e as Error).message}`));
  }

  // ------------------------------------------------------------ posting

  /** The thread a task lives in. Board-started tasks get a top-level message in the DM as their thread root. */
  private async ensureThread(task: Task): Promise<{ channel: string; ts: string } | null> {
    if (task.slackChannel && task.slackThreadTs) return { channel: task.slackChannel, ts: task.slackThreadTs };
    if (!this.dm) return null;
    const res = await this.deps.api.postMessage({ channel: this.dm, text: `:package: New task #${task.id}: ${esc(task.title)}\n<${this.deps.publicUrl}/#/task/${task.id}|Open in office>` });
    if (!res.ts) return null;
    this.deps.db.update(schema.tasks).set({ slackChannel: this.dm, slackThreadTs: res.ts }).where(eq(schema.tasks.id, task.id)).run();
    return { channel: this.dm, ts: res.ts };
  }

  private withThread<T>(taskId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.threadLocks.get(taskId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.threadLocks.set(taskId, next.catch(() => undefined));
    return next;
  }

  /** A message in a task's thread (or a plain DM when no task is given). Returns its ts. */
  private async say(text: string, task?: Task, blocks?: unknown[]): Promise<string | undefined> {
    if (!task) {
      if (!this.dm) return undefined;
      return (await this.deps.api.postMessage({ channel: this.dm, text })).ts;
    }
    return this.withThread(task.id, async () => {
      const thread = await this.ensureThread(this.deps.pipeline.getTask(task.id));
      if (!thread) return undefined;
      return (await this.deps.api.postMessage({ channel: thread.channel, thread_ts: thread.ts, text, ...(blocks ? { blocks } : {}) })).ts;
    });
  }

  private async reply(channel: string, threadTs: string, text: string): Promise<void> {
    await this.deps.api.postMessage({ channel, thread_ts: threadTs, text });
  }
}

/** Connects to Slack over Socket Mode and wires the owner's DMs and button taps to the bridge. */
export async function startSlack(config: SlackConfig, deps: Omit<SlackBridgeDeps, 'ownerId' | 'api'>): Promise<{ bridge: SlackBridge; stop: () => Promise<void> }> {
  const app = new App({ token: config.botToken, appToken: config.appToken, socketMode: true, logLevel: LogLevel.WARN });
  const api: SlackApi = {
    postMessage: (args) => app.client.chat.postMessage(args as never),
    updateMessage: (args) => app.client.chat.update(args as never),
    openDm: async (userId) => {
      const res = await app.client.conversations.open({ users: userId });
      if (!res.channel?.id) throw new Error('Slack did not open a DM with you.');
      return res.channel.id;
    },
  };
  const bridge = new SlackBridge({ ...deps, ownerId: config.ownerId, api });

  app.message(async ({ message }) => {
    const m = message as { channel_type?: string; user?: string; channel: string; ts: string; thread_ts?: string; text?: string; subtype?: string; bot_id?: string };
    if (m.channel_type !== 'im') return;
    await bridge.onMessage(m);
  });

  app.action(/^office_gate:/, async ({ ack, action, body, respond }) => {
    await ack();
    const note = await bridge.onButton(body.user?.id, (action as { action_id: string }).action_id);
    if (note) await respond({ response_type: 'ephemeral', replace_original: false, text: note }).catch(() => undefined);
  });

  await app.start();
  await bridge.start();
  return { bridge, stop: async () => { bridge.stop(); await app.stop(); } };
}
