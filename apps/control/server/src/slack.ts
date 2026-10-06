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
import { SlackQuestions } from './slackQuestions.js';
import { describeTask, duration, esc, listActive, tokens, type StatusContext } from './slackStatus.js';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, type Uploads } from './attachments.js';
import type { SlackConfig } from './config.js';

/** The slice of Slack's Web API the bridge uses (so tests can fake it). */
export interface SlackApi {
  postMessage(args: { channel: string; text: string; thread_ts?: string; blocks?: unknown[] }): Promise<{ ts?: string }>;
  updateMessage(args: { channel: string; ts: string; text: string; blocks?: unknown[] }): Promise<unknown>;
  openDm(userId: string): Promise<string>;
  /** Downloads a file shared in Slack (needs the files:read scope). */
  downloadFile?(url: string): Promise<Buffer>;
}

/** A file attached to a Slack message (the fields the office uses). */
export interface SlackFile {
  name?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
}

/** Shared files are only ever fetched from Slack itself, with the bot token. */
export function isSlackFileUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'files.slack.com';
  } catch {
    return false;
  }
}

export interface SlackBridgeDeps {
  db: Db;
  bus: EventBus;
  pipeline: Pipeline;
  docs: TaskDocs;
  ownerId: string;
  /** A private channel shared with an AI assistant (e.g. Instinct), and the user or bot ids allowed to speak in it. */
  channelId?: string;
  assistantIds?: string[];
  /** This bot's own Slack user id, so a leading @mention of it can be told from one meant for someone else. */
  botUserId?: string;
  /** Where "Open in office" links point. */
  publicUrl: string;
  api: SlackApi;
  now?: () => number;
  /** Where files attached to a Slack task message are stored until the task claims them. */
  uploads?: Uploads;
}

const STATUS_REFRESH_MS = 10_000;
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
const MAX_SECTION = 2800;
/** An assistant may start this many tasks per hour: a loop or a chatty assistant must not queue unlimited work. */
export const ASSISTANT_TASKS_PER_HOUR = 5;
/** Commands only the owner may give: they approve work, discard it or let commands run. */
const OWNER_ONLY = new Set(['approve', 'reject', 'discard', 'done', 'replan', 'send', 'enough']);

type Sender = 'owner' | 'assistant';

export { esc };

function clip(text: string, max = MAX_SECTION): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export const HELP = [
  '*Start a task:* DM me `<repo>: what to build or fix` (the repo name is optional when only one is registered), or paste a GitHub PR link to review it. `status` on its own lists every active task.',
  '*In a task thread:* `status` · `pause` / `stop` · `resume` · `steer: <note to the agent>` · `replan: <why>` · `approve` · `reject: <what to change>` · `discard` · `done`',
  "*When the architect asks you something:* tap a button, or reply in the thread with your answer. `send` sends what you've answered so far; `enough` lets it plan now.",
].join('\n');

/** While the architect has a question open, only these count as commands; anything else answers it. */
const BARE_COMMANDS = new Set(['status', 'pause', 'stop', 'resume', 'discard', 'send', 'enough', 'help']);
function isExplicitCommand(text: string): boolean {
  const t = text.trim().toLowerCase();
  return BARE_COMMANDS.has(t.replace(/[.!]$/, '')) || /^(steer|replan)\s*:/.test(t);
}

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
  private assistantStarts: number[] = [];
  /** The architect's briefing questions in task threads. */
  readonly questions: SlackQuestions;

  constructor(private deps: SlackBridgeDeps) {
    this.questions = new SlackQuestions({ ...deps, thread: (task) => this.ensureThread(task) });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async start(): Promise<void> {
    this.dm = await this.deps.api.openDm(this.deps.ownerId);
    this.unsubscribe = this.deps.bus.subscribe((m) => this.onBus(m));
    this.questions.start();
    this.timer = setInterval(() => void this.refreshStatuses(), STATUS_REFRESH_MS);
    this.timer.unref();
  }

  stop(): void {
    this.unsubscribe?.();
    this.questions.stop();
    if (this.timer) clearInterval(this.timer);
  }

  async announce(): Promise<void> {
    await this.say(`Pixel Office is online. Board: ${this.deps.publicUrl}\n${HELP}`);
  }

  // ------------------------------------------------------------ incoming: messages

  /**
   * A message in the owner's DM, or in the shared assistant channel. The owner may do anything.
   * An assistant (Instinct) may start tasks, ask for status, steer, pause and resume, only in that channel.
   */
  async onMessage(msg: { user?: string; channel: string; ts: string; thread_ts?: string; text?: string; subtype?: string; bot_id?: string; files?: SlackFile[] }): Promise<void> {
    const sender = this.senderOf(msg);
    if (!sender) return;
    let text = (msg.text ?? '').trim();
    // "@Instinct what's the status?" is for someone else: stay out of it. "@Pixel Office <command>" is for me.
    const lead = text.match(/^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>[\s,:]*/);
    if (lead) {
      if (lead[1] !== this.deps.botUserId) return;
      text = text.slice(lead[0].length).trim();
    }
    const threadReply = !!msg.thread_ts && msg.thread_ts !== msg.ts;
    if (sender === 'owner' && msg.files?.length && (threadReply || !text)) {
      // Files only attach to the message that starts a task, together with its text.
      await this.reply(msg.channel, msg.thread_ts ?? msg.ts, ':paperclip: Files attach only to a new task message, sent with its text (`<repo>: what to do`). These were not attached.');
      if (!text) return;
    }
    if (!text) return;
    try {
      if (msg.thread_ts && msg.thread_ts !== msg.ts) await this.onThreadMessage(msg.channel, msg.thread_ts, text, sender);
      else await this.onNewTask(msg.channel, msg.ts, text, sender, sender === 'owner' ? (msg.files ?? []) : []);
    } catch (e) {
      await this.reply(msg.channel, msg.thread_ts ?? msg.ts, `:warning: ${esc((e as Error).message)}`);
    }
  }

  private senderOf(msg: { user?: string; channel: string; subtype?: string; bot_id?: string }): Sender | null {
    const { ownerId, channelId, assistantIds = [] } = this.deps;
    const where = msg.channel === this.dm || (!!channelId && msg.channel === channelId);
    if (!where) return null;
    // file_share: my message with files attached (they become the task's attachments).
    if (msg.user === ownerId && (!msg.subtype || msg.subtype === 'file_share') && !msg.bot_id) return 'owner';
    const named = (msg.user && assistantIds.includes(msg.user)) || (msg.bot_id && assistantIds.includes(msg.bot_id));
    if (named && channelId && msg.channel === channelId && (!msg.subtype || msg.subtype === 'bot_message')) return 'assistant';
    return null;
  }

  private async onNewTask(channel: string, ts: string, text: string, sender: Sender, files: SlackFile[] = []): Promise<void> {
    const assistant = sender === 'assistant';
    if (/^(help|\?)$/i.test(text)) return void (await this.reply(channel, ts, HELP));
    if (/^(status|tasks)[?.!]*$/i.test(text)) return void (await this.reply(channel, ts, listActive(this.statusContext())));
    const pr = text.match(PR_URL)?.[0];
    // An assistant must be explicit (`repo: ...` or a PR link). A stray "thanks!" must never become a task.
    const parsed = pr ? null : this.parseTask(text, !assistant);
    if (!pr && !parsed?.repoId) return void (parsed?.error && !assistant ? await this.reply(channel, ts, parsed.error) : undefined);
    if (assistant && !this.assistantMayStart()) {
      return void (await this.reply(channel, ts, `:no_entry: Limit reached: an assistant can start ${ASSISTANT_TASKS_PER_HOUR} tasks an hour. Ask the owner.`));
    }
    this.claim = { channel, ts };
    try {
      if (pr) {
        const task = await this.deps.pipeline.createReviewTask(pr);
        await this.reply(channel, ts, `Reviewing PR as task #${task.id}. I'll post the draft here when it's ready.`);
        return;
      }
      const { ids, problems } = await this.fetchFiles(files);
      const task = this.deps.pipeline.createTask({ repoId: parsed!.repoId!, input: parsed!.input!, ...(ids.length ? { attachments: ids } : {}) });
      const attached = ids.length ? ` with ${ids.length} attachment${ids.length === 1 ? '' : 's'}` : '';
      await this.reply(channel, ts, `Task #${task.id} queued${attached}. Updates will appear in this thread.${problems.length ? `\n:warning: Not attached: ${esc(problems.join('; '))}` : ''}`);
    } finally {
      this.claim = null;
    }
  }

  /** Downloads the files on my task message into the office's uploads, for the new task to claim. */
  private async fetchFiles(files: SlackFile[]): Promise<{ ids: string[]; problems: string[] }> {
    const ids: string[] = [];
    const problems: string[] = [];
    if (!files.length) return { ids, problems };
    const { uploads, api } = this.deps;
    if (!uploads || !api.downloadFile) return { ids, problems: ['attachments from Slack are not set up'] };
    for (const f of files.slice(0, MAX_ATTACHMENTS)) {
      const name = f.name ?? 'file';
      const url = f.url_private_download ?? f.url_private ?? '';
      try {
        if (!isSlackFileUrl(url)) throw new Error('not a Slack file link');
        if ((f.size ?? 0) > MAX_ATTACHMENT_BYTES) throw new Error('over 10 MB');
        ids.push(uploads.save(name, await api.downloadFile(url)).id);
      } catch (e) {
        problems.push(`${name}: ${(e as Error).message}`);
      }
    }
    if (files.length > MAX_ATTACHMENTS) problems.push(`only the first ${MAX_ATTACHMENTS} files`);
    // Together over the mission limit: drop them all rather than a surprising subset.
    try {
      if (ids.length) uploads.check(ids);
    } catch (e) {
      return { ids: [], problems: [...problems, (e as Error).message] };
    }
    return { ids, problems };
  }

  private assistantMayStart(): boolean {
    const hourAgo = this.now() - 60 * 60 * 1000;
    this.assistantStarts = this.assistantStarts.filter((t) => t > hourAgo);
    if (this.assistantStarts.length >= ASSISTANT_TASKS_PER_HOUR) return false;
    this.assistantStarts.push(this.now());
    return true;
  }

  private parseTask(text: string, allowDefaultRepo = true): { repoId?: number; input?: string; error?: string } {
    const repos = listRepos(this.deps.db);
    if (repos.length === 0) return { error: 'No repos registered yet. Add one on the board under Repos first.' };
    const m = text.match(/^([\w.-]+)\s*:\s*([\s\S]+)$/);
    const named = m && repos.find((r) => r.name.toLowerCase() === m[1]!.toLowerCase());
    if (named) return { repoId: named.id, input: m![2]!.trim() };
    if (repos.length === 1 && allowDefaultRepo) return { repoId: repos[0]!.id, input: text };
    return { error: `Which repo? Start with \`<repo>: ...\`. Registered: ${repos.map((r) => `\`${esc(r.name)}\``).join(', ')}.` };
  }

  private taskForThread(channel: string, threadTs: string): Task | undefined {
    return this.deps.db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.slackChannel, channel), eq(schema.tasks.slackThreadTs, threadTs)))
      .get();
  }

  private async onThreadMessage(channel: string, threadTs: string, text: string, sender: Sender): Promise<void> {
    const task = this.taskForThread(channel, threadTs);
    if (!task) {
      // A reply in a thread that has no task (say, under the bot's help message): an explicit task starts one here.
      if (PR_URL.test(text) || this.parseTask(text, false).repoId) return void (await this.onNewTask(channel, threadTs, text, sender));
      return void (sender === 'owner' ? await this.reply(channel, threadTs, 'This thread has no task. Start one with a new message, or reply here with `<repo>: what to do`.') : undefined);
    }
    const say = (t: string) => this.reply(channel, threadTs, t);
    const { pipeline } = this.deps;
    const [, word = '', rest = ''] = text.match(/^(\w+)\s*:?\s*([\s\S]*)$/) ?? [];
    const command = word.toLowerCase();
    if (sender === 'assistant' && OWNER_ONLY.has(command)) {
      return void (await say(`:no_entry: \`${command}\` needs the owner. Ask them to do it in this thread or on the board.`));
    }
    // An assistant's chatter that isn't a command is ignored, not answered, so two bots never loop.
    if (sender === 'assistant' && !['status', 'pause', 'stop', 'resume', 'steer'].includes(command)) return;
    // Only the owner answers the architect. While a question is open, a reply is an answer unless it is
    // a bare command word ("stop") or an explicit "steer:" / "replan:": "Discard the legacy table" is an answer.
    if (sender === 'owner' && this.questions.openQuestion(task.id) && !isExplicitCommand(text) && this.questions.onThreadReply(task.id, text)) return;
    switch (command) {
      case 'status': {
        return void (await say(describeTask(pipeline.getTask(task.id), this.statusContext())));
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
      case 'send':
      case 'enough':
        if (sender !== 'owner') return;
        pipeline.briefingAction(task.id, command);
        return;
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
    return this.deps.pipeline.pendingGates(taskId).find((g) => g.kind !== 'command' && g.kind !== 'question');
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
    if (g.kind === 'question') return; // posted question by question by SlackQuestions
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

  private statusContext(): StatusContext {
    const { pipeline } = this.deps;
    return {
      db: this.deps.db,
      now: this.now(),
      publicUrl: this.deps.publicUrl,
      tokensUsed: (id, steps) => pipeline.tokensUsed(id, steps),
      pendingGates: (id) => pipeline.pendingGates(id),
      stepStartedAt: (id) => this.stepStartedAt.get(id),
    };
  }

  private statusText(task: Task): string {
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
    return parts.join(' · ');
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
    downloadFile: async (url) => {
      if (!isSlackFileUrl(url)) throw new Error('not a Slack file link');
      let res: Response;
      try {
        res = await fetch(url, { headers: { authorization: `Bearer ${config.botToken}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
      } catch (e) {
        // Without files:read, Slack redirects to its login page, which redirect: 'error' refuses.
        throw new Error((e as Error).name === 'TimeoutError' ? 'download timed out' : 'Slack refused the download: the app may need the files:read permission (reinstall it)');
      }
      if (!res.ok) throw new Error(res.status === 403 ? 'the Slack app needs the files:read permission (reinstall it)' : `download failed (${res.status})`);
      if (Number(res.headers.get('content-length') ?? 0) > MAX_ATTACHMENT_BYTES) throw new Error('over 10 MB');
      // Read with a cap, so a missing or wrong content-length can't fill memory.
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of res.body ?? []) {
        size += (chunk as Uint8Array).length;
        if (size > MAX_ATTACHMENT_BYTES) throw new Error('over 10 MB');
        chunks.push(Buffer.from(chunk as Uint8Array));
      }
      const data = Buffer.concat(chunks);
      // Without files:read Slack answers with its HTML login page instead of the file.
      if ((res.headers.get('content-type') ?? '').startsWith('text/html') && !url.toLowerCase().endsWith('.html')) throw new Error('Slack sent a login page: the app needs files:read');
      return data;
    },
  };
  const botUserId = (await app.client.auth.test()).user_id;
  const bridge = new SlackBridge({ ...deps, ownerId: config.ownerId, channelId: config.channelId, assistantIds: config.assistantIds, botUserId, api });

  app.message(async ({ message }) => {
    const m = message as { channel_type?: string; user?: string; channel: string; ts: string; thread_ts?: string; text?: string; subtype?: string; bot_id?: string; files?: SlackFile[] };
    // The owner's DM with the bot, or the one private channel shared with the assistant.
    if (m.channel_type !== 'im' && !(config.channelId && m.channel === config.channelId)) return;
    await bridge.onMessage(m);
  });

  app.action(/^office_q:/, async ({ ack, action, body, respond }) => {
    await ack();
    const note = await bridge.questions.onButton(body.user?.id, (action as { action_id: string }).action_id);
    if (note) await respond({ response_type: 'ephemeral', replace_original: false, text: note }).catch(() => undefined);
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
