// The Slack side of the office: talk to Fury in plain language, then follow each task in its thread.
//
// Every message from the owner (or the allowed assistant) is a turn of a conversation with Fury
// (fury.ts), one conversation per Slack thread. Fury acts through tools (furyTools.ts) that make the
// same Pipeline calls the board does. One thread per task, with a single status message edited about
// every 10 seconds; new messages only for gates, milestones and alerts, and the heroes post their own
// handoffs under their own names. Only the owner's button taps are honoured.

import { App, LogLevel, SocketModeReceiver } from '@slack/bolt';
import { and, eq } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { schema } from './db/index.js';
import type { Gate, Task } from './db/schema.js';
import { isAgentStep, stepRole, TERMINAL_STATUSES, type GateDecision } from './domain.js';
import type { BusMessage, EventBus } from './events.js';
import type { TaskDocs } from './handoffs.js';
import { CONTRACTS } from './handoffs.js';
import type { Pipeline } from './pipeline.js';
import { listRepos } from './repos.js';
import { changedFiles } from './worktree.js';
import { SlackLink } from './slackLink.js';
import { SlackQuestions } from './slackQuestions.js';
import { alertText, breakdownSummary, handoffText, mergeSummary, planSummary, pushSummary, reviewPostSummary, statusBlocks, verificationText, type CheckStage, type Verdict } from './slackFormat.js';
import { duration, esc, stageOf, waitingOnYou, type StatusContext } from './slackStatus.js';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, type Uploads } from './attachments.js';
import type { SlackConfig } from './config.js';
import type { ConversationStore } from './conversations.js';
import { NO_REPLY, type DeskRunner } from './fury.js';
import { buildDeskTools, type DeskHost, type Sender } from './furyTools.js';
import { heroForRole, type Hero } from './heroes.js';

/** The slice of Slack's Web API the bridge uses (so tests can fake it). */
export interface SlackApi {
  /** `username` and `icon_emoji` post as a hero; they need the chat:write.customize scope. */
  postMessage(args: { channel: string; text: string; thread_ts?: string; blocks?: unknown[]; username?: string; icon_emoji?: string }): Promise<{ ts?: string }>;
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
  /** Fury: runs a turn of the conversation, and remembers each thread's session. */
  desk: { runner: DeskRunner; conversations: ConversationStore };
}

const STATUS_REFRESH_MS = 10_000;
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
const MAX_SECTION = 2800;
/** An assistant may start this many tasks per hour: a loop or a chatty assistant must not queue unlimited work. */
export const ASSISTANT_TASKS_PER_HOUR = 5;
/**
 * An assistant's messages are answered by Fury, so two bots could keep each other talking for ever.
 * Past this many an hour its messages are ignored (once, with a note).
 */
export const ASSISTANT_TURNS_PER_HOUR = 40;
/** A hero's first words after being steered are posted under their name only if they come within this long. */
const HERO_REPLY_WINDOW_MS = 15 * 60 * 1000;

/** What a decided gate was about, for the line that replaces its buttons. */
const DECIDED_WHAT: Record<string, string> = { plan: 'the plan', breakdown: 'the milestones', push: 'the push', merge: 'the merge', deploy: 'the staging deploy', rollback: 'the rollback', review_post: 'the review', command: 'the command' };

/** Button labels per gate kind (approve, reject). Deploy and rollback decide on the tap; the others ask why. */
const GATE_BUTTONS: Partial<Record<string, [string, string]>> = {
  review_post: ['Post review', 'Reject…'],
  merge: ['Merge', 'Changes needed…'],
  deploy: ['Deploy now', 'Not now'],
  rollback: ['Roll back', 'Keep it'],
};
const DECIDE_ON_TAP = new Set(['deploy', 'rollback']);

const GATE_HEADING = {
  plan: 'Plan ready for approval',
  breakdown: 'Milestones ready for approval (each becomes its own task)',
  push: 'Ready to push and open the PR',
  merge: 'PR is open: merge it?',
  deploy: 'Merged: deploy to staging now?',
  rollback: 'Staging check failed: roll staging back?',
  review_post: 'Draft review ready to post',
} as const;

export { esc };

function clip(text: string, max = MAX_SECTION): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const FURY = heroForRole('manager')!;

interface Incoming {
  user?: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  text?: string;
  subtype?: string;
  bot_id?: string;
  files?: SlackFile[];
}

export class SlackBridge {
  private dm: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** The thread a task being created right now becomes the task thread of: the conversation it was asked for in. */
  private claim: { channel: string; ts: string } | null = null;
  private stepStartedAt = new Map<number, number>();
  private lastStatusText = new Map<number, string>();
  private lastStatus = new Map<number, string>();
  private threadLocks = new Map<number, Promise<unknown>>();
  /** One turn at a time per conversation, so its session id never forks. */
  private deskLocks = new Map<string, Promise<unknown>>();
  private assistantStarts: number[] = [];
  private assistantTurns: number[] = [];
  private assistantCapNoted = false;
  /** Heroes the owner just steered: their next words are posted in the thread under their name. */
  private heroReplies = new Map<number, { role: string; at: number }>();
  /** Set once Slack says the app can't post under another name (the chat:write.customize scope is missing). */
  private noCustomize = false;
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
    await this.say(`Pixel Office is online. Board: ${this.deps.publicUrl}\nTell me what you need in your own words: a task to start, how one is going, or what to change.`);
  }

  // ------------------------------------------------------------ incoming: messages

  /**
   * A message in the owner's DM, or in the shared assistant channel. It goes to Fury, who answers in the
   * message's thread (a top-level message starts one). The owner may do anything Fury has a tool for.
   * An assistant (Instinct) may start tasks, ask for status, steer, pause and resume, only in that channel.
   */
  async onMessage(msg: Incoming): Promise<void> {
    const sender = this.senderOf(msg);
    if (!sender) return;
    let text = (msg.text ?? '').trim();
    // "@Instinct what's the status?" is for someone else: stay out of it. "@Pixel Office <message>" is for me.
    const lead = text.match(/^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>[\s,:]*/);
    if (lead) {
      if (lead[1] !== this.deps.botUserId) return;
      text = text.slice(lead[0].length).trim();
    }
    if (!text) return;
    const threadTs = msg.thread_ts ?? msg.ts;
    if (sender === 'assistant') {
      const turn = this.assistantMayTalk();
      if (turn !== 'yes') return void (turn === 'once' ? await this.reply(msg.channel, threadTs, `:no_entry: Limit reached: an assistant gets ${ASSISTANT_TURNS_PER_HOUR} turns an hour. Ask the owner.`) : undefined);
    }
    try {
      await this.deskTurn(msg, sender, text, sender === 'owner' ? (msg.files ?? []) : []);
    } catch (e) {
      await this.reply(msg.channel, threadTs, `:warning: ${esc((e as Error).message)}`);
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

  private assistantMayTalk(): 'yes' | 'once' | 'no' {
    const hourAgo = this.now() - 60 * 60 * 1000;
    this.assistantTurns = this.assistantTurns.filter((t) => t > hourAgo);
    if (this.assistantTurns.length >= ASSISTANT_TURNS_PER_HOUR) {
      const first = !this.assistantCapNoted;
      this.assistantCapNoted = true;
      return first ? 'once' : 'no';
    }
    this.assistantCapNoted = false;
    this.assistantTurns.push(this.now());
    return 'yes';
  }

  // ------------------------------------------------------------ Fury

  /** Runs one turn of the thread's conversation and posts Fury's answer in it. */
  private deskTurn(msg: Incoming, sender: Sender, text: string, files: SlackFile[]): Promise<void> {
    const { channel } = msg;
    const threadTs = msg.thread_ts ?? msg.ts;
    const key = `${channel}:${threadTs}`;
    const prev = this.deskLocks.get(key) ?? Promise.resolve();
    const turn = prev
      .catch(() => undefined)
      .then(async () => {
        const { runner, conversations } = this.deps.desk;
        const tools = buildDeskTools({ sender, db: this.deps.db, pipeline: this.deps.pipeline, status: this.statusContext(), host: this.host(sender, channel, threadTs, files) });
        const reply = await runner.run({ prompt: this.briefing(channel, threadTs, sender, text, files), sessionId: conversations.get(channel, threadTs), tools });
        if (reply.sessionId) conversations.set(channel, threadTs, reply.sessionId);
        const answer = reply.text.trim();
        // Nothing to say (an assistant's thanks): stay quiet so two bots don't keep each other talking.
        if (!answer || answer === NO_REPLY) return;
        await this.sayAs(FURY, clip(answer, 3500), { channel, ts: threadTs });
      });
    this.deskLocks.set(key, turn.catch(() => undefined));
    return turn;
  }

  /** The header the office writes above the sender's words: facts Fury can rely on. */
  private briefing(channel: string, threadTs: string, sender: Sender, text: string, files: SlackFile[]): string {
    const { db, pipeline } = this.deps;
    const repos = listRepos(db);
    const lines = [
      `From: ${sender === 'owner' ? 'the owner' : 'the assistant (Instinct)'}`,
      `Repos: ${repos.length ? repos.map((r) => r.name).join(', ') : 'none registered'}`,
    ];
    const task = this.taskForThread(channel, threadTs);
    if (task) {
      const waiting = waitingOnYou(task, pipeline.pendingGates(task.id));
      lines.push(`This thread's task: #${task.id} "${task.title}", ${task.status.replace(/_/g, ' ')}${waiting ? `; waiting on the owner: ${waiting}` : ''}`);
      const q = sender === 'owner' ? this.questions.openQuestion(task.id) : undefined;
      if (q) {
        lines.push(`Open question from the architect (id ${q.id}): ${q.title}\n${q.body}${q.options.length ? `\nOptions: ${q.options.join(' | ')}` : ''}${q.recommended ? `\nRecommended: ${q.recommended}` : ''}`);
      }
    } else {
      lines.push("This thread's task: none yet");
    }
    if (files.length) lines.push(`Files attached to this message: ${files.map((f) => f.name ?? 'file').join(', ')}`);
    return `${lines.join('\n')}\n\nMessage:\n${text}`;
  }

  /** What Fury's tools need from the bridge: the thread, the message's files and the assistant's task limit. */
  private host(sender: Sender, channel: string, threadTs: string, files: SlackFile[]): DeskHost {
    return {
      startTask: (a) => this.startTask(sender, channel, threadTs, files, a),
      reviewPr: (url) => this.reviewPr(sender, channel, threadTs, url),
      expectHeroReply: (taskId, role) => void this.heroReplies.set(taskId, { role, at: this.now() }),
    };
  }

  /**
   * Starts a task for Fury. The thread the conversation is in becomes the task's thread (its status
   * message, gate buttons and updates go there), unless that thread already belongs to a task: then
   * the new one gets its own thread in the owner's DM.
   */
  private async startTask(sender: Sender, channel: string, threadTs: string, files: SlackFile[], a: Parameters<DeskHost['startTask']>[0]): Promise<string> {
    const repos = listRepos(this.deps.db);
    if (repos.length === 0) throw new Error('No repos registered yet. Add one on the board under Repos first.');
    const byName = (n: string) => repos.find((r) => r.name.toLowerCase() === n.trim().toLowerCase());
    const registered = repos.map((r) => r.name).join(', ');
    const repo = a.repo ? byName(a.repo) : repos.length === 1 ? repos[0] : undefined;
    if (!repo) throw new Error(a.repo ? `Not registered: "${a.repo}". Registered: ${registered}.` : `Which repo? Registered: ${registered}.`);
    const unknown = a.refRepos.filter((n) => !byName(n));
    if (unknown.length) throw new Error(`Not registered: ${unknown.join(', ')}. Registered: ${registered}.`);
    if (sender === 'assistant' && !this.assistantMayStart()) throw new Error(`Limit reached: an assistant can start ${ASSISTANT_TASKS_PER_HOUR} tasks an hour. Ask the owner.`);
    const { ids, problems } = await this.fetchFiles(files);
    const here = !this.taskForThread(channel, threadTs);
    // Set only around the synchronous create, so nothing else created meanwhile takes this thread.
    this.claim = here ? { channel, ts: threadTs } : null;
    let task: Task;
    try {
      task = this.deps.pipeline.createTask({
        repoId: repo.id,
        input: a.request,
        refRepos: a.refRepos.map((n) => byName(n)!.id),
        ...(a.links.length ? { links: a.links } : {}),
        ...(a.lane !== 'auto' ? { lane: a.lane } : {}),
        ...(ids.length ? { attachments: ids } : {}),
      });
    } finally {
      this.claim = null;
    }
    const attached = ids.length ? ` with ${ids.length} attachment${ids.length === 1 ? '' : 's'}` : '';
    return [
      `Started #${task.id} on ${repo.name}${attached}: "${task.title}".`,
      here ? 'Its updates will appear in this thread.' : "This thread already has a task, so the new one has its own thread in the owner's DM.",
      problems.length ? `Not attached: ${problems.join('; ')}` : '',
    ]
      .filter(Boolean)
      .join(' ');
  }

  private async reviewPr(sender: Sender, channel: string, threadTs: string, text: string): Promise<string> {
    const url = text.match(PR_URL)?.[0];
    if (!url) throw new Error('That is not a GitHub pull request link (https://github.com/<owner>/<repo>/pull/<n>).');
    if (sender === 'assistant' && !this.assistantMayStart()) throw new Error(`Limit reached: an assistant can start ${ASSISTANT_TASKS_PER_HOUR} tasks an hour. Ask the owner.`);
    this.claim = this.taskForThread(channel, threadTs) ? null : { channel, ts: threadTs };
    try {
      const task = await this.deps.pipeline.createReviewTask(url);
      return `Reviewing the PR as #${task.id}. The draft review will be posted for the owner to approve.`;
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

  private taskForThread(channel: string, threadTs: string): Task | undefined {
    return this.deps.db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.slackChannel, channel), eq(schema.tasks.slackThreadTs, threadTs)))
      .get();
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
    if (decision === 'reject' && !DECIDE_ON_TAP.has(gate.kind)) {
      const task = this.deps.pipeline.getTask(gate.taskId);
      await this.say('Tell me what to change, here in the thread, and I will send it back.', task);
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
        if (event.payload.status === 'ok') void this.handoff(task, event.payload).catch((e) => console.warn(`Slack: ${(e as Error).message}`));
        return this.renderStatus(task);
      case 'text':
        return this.heroSpeaks(task, event.payload);
      case 'gate':
        return this.onGate(task, event.payload as { gateId: number; kind: Gate['kind']; subject: string | null; status: string; auto: boolean });
      case 'gate_decided':
        return this.onGateDecided(task, event.payload as { gateId: number; decision: string; comment?: string });
      case 'alert': {
        const text = alertText(String(event.payload.kind ?? ''), String(event.payload.message ?? ''));
        return void (text ? await this.say(text, task) : undefined);
      }
      case 'pr_opened':
        return void (await this.say(`:rocket: PR opened: ${String(event.payload.url)}`, task));
      case 'pr_updated':
        return void (await this.say(`:arrows_counterclockwise: PR updated with the changes: ${String(event.payload.url)}`, task));
      case 'pr_merged':
        return void (await this.say(`:tada: PR merged${event.payload.by === 'github' ? ' on GitHub' : ''}: ${String(event.payload.url)}`, task));
      case 'deploy_started':
        return void (await this.say(`:rocket: Merged. Deploying to staging${event.payload.project ? ` (${esc(String(event.payload.project))})` : ''}…`, task));
      case 'deployed':
        return void (await this.say(':white_check_mark: Deployed to staging. The verifier is checking it now.', task));
      case 'rolled_back':
        return void (await this.say(':leftwards_arrow_with_hook: Staging rolled back to the previous version.', task));
      case 'review_added':
        return void (await this.say(`:mag: The reviewer checks it before the PR opens: ${esc(String(event.payload.reason ?? ''))}.`, task));
      case 'verified':
        return void (await this.sayAs(
          heroForRole('verifier'),
          verificationText(event.payload.verdict as Verdict, String(event.payload.report ?? ''), (event.payload.stage as CheckStage | undefined) ?? 'build', event.payload.sha as string | undefined),
          task,
        ));
      case 'review_posted':
        return void (await this.say(`:memo: Review posted: ${String(event.payload.url)}`, task));
      case 'epic_decided':
        return void (await this.say(':world_map: This is too big for one task: the architect is splitting it into milestones for you to approve.', task));
      case 'epic_split': {
        const ids = (event.payload.children as number[]) ?? [];
        return void (await this.say(`:white_check_mark: Split into ${ids.length} milestone tasks: ${ids.map((id) => `#${id}`).join(', ')}. Each gets its own thread and runs after the one before it opens its PR.`, task));
      }
      case 'lane_decided': {
        if (String(event.payload.lane) === 'standard') return;
        return void (await this.say(':zap: Route: *solo*. The all-rounder builds it alone (reads, changes, tests and reviews its own diff), then the PR opens for you. A big diff gets one extra review.', task));
      }
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
      await this.say(`:double_vertical_bar: ${word}.${task.statusNote ? ` ${esc(task.statusNote)}` : ''} Tell me to resume it when you are ready.`, task);
    } else if (previous) {
      await this.renderStatus(task);
    }
  }

  private async onGate(task: Task, g: { gateId: number; kind: Gate['kind']; subject: string | null; status: string; auto: boolean }): Promise<void> {
    if (g.status !== 'pending') {
      // Plans go ahead on their own (Strange has just posted it): say so, with the way to change course.
      if (g.auto && g.kind === 'plan') await this.say(':arrow_forward: Going ahead with the plan. Ask for a new plan if it\'s off.', task);
      else if (g.auto && g.kind !== 'command') await this.say(`:white_check_mark: ${g.kind === 'push' ? 'Push' : 'Gate'} auto-approved.`, task);
      return;
    }
    if (g.kind === 'question') return; // posted question by question by SlackQuestions
    const link = `${this.deps.publicUrl}/#/task/${task.id}`;
    const isCommand = g.kind === 'command';
    const heading = isCommand ? ':lock: *Allow this command?*' : `:raised_hand: *${GATE_HEADING[g.kind as keyof typeof GATE_HEADING] ?? 'Needs your decision'}*`;
    const body = isCommand ? `\`\`\`${clip(g.subject ?? '', 1500).replace(/```/g, "'''")}\`\`\`` : this.gateSummary(task, g.kind);
    const buttons = isCommand
      ? [this.button(g.gateId, 'allow_once', 'Allow once', 'primary'), this.button(g.gateId, 'allow_always', 'Always for this repo'), this.button(g.gateId, 'deny', 'Deny', 'danger')]
      : [
          this.button(g.gateId, 'approve', GATE_BUTTONS[g.kind]?.[0] ?? 'Approve', 'primary'),
          this.button(g.gateId, 'reject', GATE_BUTTONS[g.kind]?.[1] ?? 'Reject…', 'danger'),
        ];
    // A short summary with the buttons right under it; the full document is one tap away on the board.
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: `${heading}\n*#${task.id}* ${esc(clip(task.title, 90))}` } },
      ...(body ? [{ type: 'section', text: { type: 'mrkdwn', text: clip(body, MAX_SECTION) } }] : []),
      { type: 'actions', elements: [...buttons, { type: 'button', text: { type: 'plain_text', text: isCommand ? 'Open in office' : 'Read in full' }, url: link }] },
    ];
    const ask = isCommand ? 'allow a command?' : (GATE_HEADING[g.kind as keyof typeof GATE_HEADING] ?? 'needs you').toLowerCase();
    const ts = await this.say(`#${task.id} ${esc(clip(task.title, 60))}: ${ask}`, task, blocks);
    if (ts) this.deps.db.update(schema.gates).set({ slackTs: ts }).where(eq(schema.gates.id, g.gateId)).run();
  }

  /** A few lines about what the owner is being asked to approve. */
  private gateSummary(task: Task, kind: Gate['kind']): string {
    const { docs } = this.deps;
    switch (kind) {
      case 'plan':
        return planSummary(docs.latest(task.id, 'plan') ?? '');
      case 'breakdown':
        return breakdownSummary(docs.latest(task.id, 'breakdown') ?? '');
      case 'review_post':
        return reviewPostSummary(docs.latest(task.id, 'pr-review') ?? '');
      case 'push':
        return pushSummary({ changes: docs.latest(task.id, 'changes'), review: docs.latest(task.id, 'review'), testReport: docs.latest(task.id, 'test-report') });
      case 'deploy':
        return `PR: ${task.prUrl ?? 'merged'}. Staging serves real users, so the deploy waits for you.`;
      case 'rollback':
        return esc(clip(this.deps.docs.latest(task.id, 'verify')?.replace(/^---[\s\S]*?---\s*/, '') ?? '', 1500));
      case 'merge':
        return mergeSummary(task.prUrl, { changes: docs.latest(task.id, 'changes'), review: docs.latest(task.id, 'review'), testReport: docs.latest(task.id, 'test-report') });
      default:
        return '';
    }
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
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${d.decision === 'approve' || d.decision.startsWith('allow') ? ':white_check_mark:' : ':no_entry:'} *${esc(verb)}* · ${DECIDED_WHAT[gate.kind] ?? gate.kind}\n#${task.id} ${esc(clip(task.title, 90))}${d.comment ? `\n>${esc(clip(d.comment, 500))}` : ''}` } }],
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

  private statusView(task: Task): { text: string; blocks: unknown[] } {
    const running = isAgentStep(task.status);
    const started = this.stepStartedAt.get(task.id) ?? task.updatedAt;
    return statusBlocks({
      task,
      agent: running ? (stepRole(task.status, task) ?? null) : null,
      elapsed: running ? duration(this.now() - started) : null,
      stage: stageOf(task),
      tokens: this.deps.pipeline.tokensUsed(task.id),
    });
  }

  /** Posts or edits the task's single status message. */
  private async renderStatus(task: Task): Promise<void> {
    await this.withThread(task.id, async () => {
      const fresh = this.deps.pipeline.getTask(task.id);
      const thread = await this.ensureThread(fresh);
      if (!thread) return;
      const view = this.statusView(fresh);
      const key = JSON.stringify(view.blocks);
      if (this.lastStatusText.get(fresh.id) === key && fresh.slackStatusTs) return;
      if (fresh.slackStatusTs) {
        await this.deps.api.updateMessage({ channel: thread.channel, ts: fresh.slackStatusTs, ...view });
      } else {
        const res = await this.deps.api.postMessage({ channel: thread.channel, thread_ts: thread.ts, ...view });
        if (res.ts) this.deps.db.update(schema.tasks).set({ slackStatusTs: res.ts }).where(eq(schema.tasks.id, fresh.id)).run();
      }
      this.lastStatusText.set(fresh.id, key);
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
    return this.sayAs(undefined, text, task, blocks);
  }

  /**
   * Like say, but under a hero's name and emoji when one is given. A task's thread is looked up for a
   * task; a `{ channel, ts }` is that thread itself.
   */
  private async sayAs(hero: Hero | undefined, text: string, to?: Task | { channel: string; ts: string }, blocks?: unknown[]): Promise<string | undefined> {
    if (!to) {
      if (!this.dm) return undefined;
      return (await this.post({ channel: this.dm, text }, hero)).ts;
    }
    if (!('id' in to)) return (await this.post({ channel: to.channel, thread_ts: to.ts, text, ...(blocks ? { blocks } : {}) }, hero)).ts;
    const task = to;
    return this.withThread(task.id, async () => {
      const thread = await this.ensureThread(this.deps.pipeline.getTask(task.id));
      if (!thread) return undefined;
      return (await this.post({ channel: thread.channel, thread_ts: thread.ts, text, ...(blocks ? { blocks } : {}) }, hero)).ts;
    });
  }

  /**
   * Posts, under the hero's name if the app may. Without the chat:write.customize scope Slack refuses a
   * custom name: the message is then posted as the app, with the hero's name in front of it, so it is
   * never lost.
   */
  private async post(args: { channel: string; text: string; thread_ts?: string; blocks?: unknown[] }, hero?: Hero): Promise<{ ts?: string }> {
    if (!hero) return this.deps.api.postMessage(args);
    if (!this.noCustomize) {
      try {
        return await this.deps.api.postMessage({ ...args, username: hero.name, icon_emoji: hero.emoji });
      } catch (e) {
        const reason = (e as { data?: { error?: string } }).data?.error ?? (e as Error).message;
        if (/missing_scope|not_allowed_token_type|invalid_arguments/.test(reason)) this.noCustomize = true;
        console.warn(`Slack: could not post as ${hero.name} (${reason}); posting as the app. Reinstall the app to add chat:write.customize.`);
      }
    }
    return this.deps.api.postMessage({ ...args, text: `*${hero.name}:* ${args.text}` });
  }

  private async reply(channel: string, threadTs: string, text: string): Promise<void> {
    await this.deps.api.postMessage({ channel, thread_ts: threadTs, text });
  }

  // ------------------------------------------------------------ heroes speak

  /** A hero's handoff when their step ends: the plan, "done: 4 files", the review verdict, the test result. */
  private async handoff(task: Task, payload: Record<string, unknown>): Promise<void> {
    const hero = heroForRole(String(payload.role ?? ''));
    const step = String(payload.step ?? '');
    if (!hero || !(step in CONTRACTS)) return;
    // The pipeline saves the step's document right after announcing that the step ended.
    await new Promise((resolve) => setImmediate(resolve));
    const fresh = this.deps.pipeline.getTask(task.id);
    const doc = this.deps.docs.latest(task.id, CONTRACTS[step as keyof typeof CONTRACTS].doc);
    let files: number | null = null;
    if (step === 'coding' && fresh.worktreePath && fresh.baseSha) files = (await changedFiles(fresh.worktreePath, fresh.baseSha).catch(() => null))?.length ?? null;
    const text = handoffText(step, doc, files);
    if (text) await this.sayAs(hero, text, fresh);
  }

  /** The first words of a hero the owner just steered are posted under their name. */
  private async heroSpeaks(task: Task, payload: Record<string, unknown>): Promise<void> {
    const waiting = this.heroReplies.get(task.id);
    if (!waiting) return;
    this.heroReplies.delete(task.id);
    const hero = heroForRole(waiting.role);
    const text = String(payload.text ?? '').trim();
    if (!hero || !text || this.now() - waiting.at > HERO_REPLY_WINDOW_MS) return;
    await this.sayAs(hero, esc(clip(text, 900)), task);
  }
}

/** Connects to Slack over Socket Mode and wires the owner's DMs and button taps to the bridge. */
export async function startSlack(config: SlackConfig, deps: Omit<SlackBridgeDeps, 'ownerId' | 'api'>): Promise<{ bridge: SlackBridge; stop: () => Promise<void> }> {
  // The office reconnects the socket itself (slackLink.ts): the client's own reconnect gives up for good
  // after a network error. One quick try per connect, so the link's waits apply: left alone, the client
  // retries a network error for hours, waiting longer each time.
  const receiver = new SocketModeReceiver({
    appToken: config.appToken,
    logLevel: LogLevel.WARN,
    autoReconnectEnabled: false,
    installerOptions: { clientOptions: { retryConfig: { retries: 0 } } },
  });
  // Initialised below, inside the retry: Bolt keeps the result of its token check, so one that failed
  // while the network was down must not outlive this attempt.
  const app = new App({ token: config.botToken, receiver, logLevel: LogLevel.WARN, deferInitialization: true });
  // Listens from the start, so a drop between Slack's hello and the end of startup isn't missed.
  const link = new SlackLink(receiver.client);
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
  let bridge: SlackBridge | null = null;
  try {
    await app.init();
    const botUserId = (await app.client.auth.test()).user_id;
    bridge = new SlackBridge({ ...deps, ownerId: config.ownerId, channelId: config.channelId, assistantIds: config.assistantIds, botUserId, api });
    listen(app, bridge, config);
    await app.start();
    await bridge.start();
  } catch (e) {
    // The caller tries again from scratch: leave no socket behind (its handlers would still pick up events).
    link.stop();
    bridge?.stop();
    await app.stop().catch(() => undefined);
    throw e;
  }
  link.arm();
  const started = bridge;
  return {
    bridge: started,
    stop: async () => {
      link.stop();
      started.stop();
      await app.stop();
    },
  };
}

/** Routes Slack messages and button taps to the bridge. */
function listen(app: App, bridge: SlackBridge, config: SlackConfig): void {
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

}
