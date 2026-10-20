// The architect's briefing questions in Slack: one message per question in the task's thread, with
// buttons for the recommendation, each option, "you decide", "send what I've answered" and "enough".
// A typed answer goes through Fury (answer_question). The board and Slack share one question row: the
// first answer counts and the other side updates.

import { and, asc, eq } from 'drizzle-orm';
import { answerText } from './briefing.js';
import type { Db } from './db/index.js';
import { schema } from './db/index.js';
import type { Question, Task } from './db/schema.js';
import type { BusMessage, EventBus } from './events.js';
import type { Pipeline } from './pipeline.js';

/** The slice of the Slack API this needs (the bridge's SlackApi fits). */
export interface QuestionsSlackApi {
  postMessage(args: { channel: string; text: string; thread_ts?: string; blocks?: unknown[] }): Promise<{ ts?: string }>;
  updateMessage(args: { channel: string; ts: string; text: string; blocks?: unknown[] }): Promise<unknown>;
}

export interface SlackQuestionsDeps {
  db: Db;
  bus: EventBus;
  pipeline: Pick<Pipeline, 'answerQuestion' | 'briefingAction' | 'getTask'> & Partial<Pick<Pipeline, 'briefingStep'>>;
  api: QuestionsSlackApi;
  ownerId: string;
  publicUrl: string;
  /** The task's Slack thread, created when it has none yet (the bridge's ensureThread). */
  thread(task: Task): Promise<{ channel: string; ts: string } | null>;
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (t: string, max: number) => (t.length <= max ? t : `${t.slice(0, max - 1)}…`);
/** Slack button labels are at most 75 characters. */
const label = (t: string) => clip(t.replace(/\s+/g, ' ').trim(), 70);

export const QUESTION_ACTION = /^office_q:(\d+):(rec|decide|send|enough|opt(\d))$/;

export class SlackQuestions {
  private unsubscribe: (() => void) | null = null;
  /** Posting is serialised per task, so "answered" edits never race the next question's post. */
  private locks = new Map<number, Promise<unknown>>();

  constructor(private deps: SlackQuestionsDeps) {}

  start(): void {
    this.unsubscribe = this.deps.bus.subscribe((m) => void this.onBus(m).catch((e) => console.warn(`Slack questions: ${(e as Error).message}`)));
  }

  stop(): void {
    this.unsubscribe?.();
  }

  private serial<T>(taskId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(taskId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(taskId, next.catch(() => undefined));
    return next;
  }

  private async onBus(msg: BusMessage): Promise<void> {
    if (msg.type !== 'event' || msg.event.taskId === null) return;
    const { event } = msg;
    const taskId = event.taskId!;
    const gateId = Number(event.payload.gateId);
    if (event.type === 'question_round') return this.serial(taskId, () => this.postNext(taskId, gateId));
    if (event.type === 'question_answered') {
      return this.serial(taskId, async () => {
        await this.markAnswered(Number(event.payload.questionId));
        await this.postNext(taskId, gateId);
      });
    }
    if (event.type === 'gate_decided' && event.payload.kind === 'question') {
      return this.serial(taskId, () => this.onRoundClosed(taskId, gateId, String(event.payload.decision)));
    }
  }

  private roundQuestions(gateId: number): Question[] {
    return this.deps.db.select().from(schema.questions).where(eq(schema.questions.gateId, gateId)).orderBy(asc(schema.questions.idx)).all();
  }

  private gateOpen(gateId: number): boolean {
    return this.deps.db.select().from(schema.gates).where(and(eq(schema.gates.id, gateId), eq(schema.gates.status, 'pending'))).get() !== undefined;
  }

  /** Posts the round's first open question that isn't in Slack yet (one at a time). */
  private async postNext(taskId: number, gateId: number): Promise<void> {
    if (!this.gateOpen(gateId)) return;
    const qs = this.roundQuestions(gateId);
    const open = qs.filter((q) => q.answer === null && !q.delegated);
    // Still waiting on one I already posted: don't stack a second question under it.
    if (open.some((q) => q.slackTs)) return;
    const next = open[0];
    if (!next) return;
    const task = this.deps.pipeline.getTask(taskId);
    const thread = await this.deps.thread(task);
    if (!thread) return;
    const answeredSoFar = qs.some((q) => q.answer !== null || q.delegated);
    const res = await this.deps.api.postMessage({
      channel: thread.channel,
      thread_ts: thread.ts,
      text: `#${task.id} The architect asks: ${next.title}`,
      blocks: this.questionBlocks(task, next, qs.length, answeredSoFar),
    });
    if (res.ts) this.deps.db.update(schema.questions).set({ slackTs: res.ts }).where(eq(schema.questions.id, next.id)).run();
  }

  /** Whether the open briefing is an epic's, before its split (else before a plan). */
  private splitting(taskId: number): boolean {
    return this.deps.pipeline.briefingStep?.(taskId) === 'splitting';
  }

  questionBlocks(task: Task, q: Question, total: number, answeredSoFar: boolean): unknown[] {
    const head = `:question: *Question ${q.idx + 1} of ${total}* · round ${q.round} · <${this.deps.publicUrl}/#/task/${task.id}|#${task.id} ${esc(clip(task.title, 60))}>`;
    const body = [`*${esc(q.title)}*`, esc(clip(q.body, 2400))];
    if (q.options.length) body.push(q.options.map((o, i) => `${i + 1}. ${esc(o)}`).join('\n'));
    if (q.recommended) body.push(`_Recommended:_ ${esc(clip(q.recommended, 500))}`);
    const button = (action: string, text: string, style?: 'primary' | 'danger') => ({
      type: 'button',
      action_id: `office_q:${q.id}:${action}`,
      text: { type: 'plain_text', text: label(text) },
      ...(style ? { style } : {}),
    });
    const answers = [
      ...(q.recommended ? [button('rec', 'Lock it in', 'primary')] : []),
      ...q.options.slice(0, 5).map((o, i) => button(`opt${i}`, o)),
      button('decide', 'You decide'),
    ];
    const enough = this.splitting(task.id) ? 'Enough, split it now' : 'Enough, start planning';
    const round = [...(answeredSoFar ? [button('send', "Send what I've answered")] : []), button('enough', enough, 'danger')];
    return [
      // Slack refuses a section over 3000 characters.
      { type: 'section', text: { type: 'mrkdwn', text: clip(`${head}\n${body.join('\n\n')}`, 2900) } },
      { type: 'actions', elements: answers },
      { type: 'actions', elements: round },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Or tell me your own answer in this thread.' }] },
    ];
  }

  /** Replaces a posted question's buttons with the answer, wherever it was given. */
  private async markAnswered(questionId: number): Promise<void> {
    const q = this.deps.db.select().from(schema.questions).where(eq(schema.questions.id, questionId)).get();
    if (!q?.slackTs) return;
    const task = this.deps.pipeline.getTask(q.taskId);
    if (!task.slackChannel) return;
    const where = q.answeredVia === 'board' ? ' (on the board)' : '';
    const text = `:white_check_mark: *${esc(q.title)}:* ${esc(clip(answerText(q), 800))}${where}`;
    await this.deps.api.updateMessage({ channel: task.slackChannel, ts: q.slackTs, text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] });
  }

  private async onRoundClosed(taskId: number, gateId: number, decision: string): Promise<void> {
    const task = this.deps.pipeline.getTask(taskId);
    // Questions still showing buttons (skipped by "send" or "enough"): say so on each.
    for (const q of this.roundQuestions(gateId).filter((x) => x.slackTs && x.answer === null && !x.delegated)) {
      if (!task.slackChannel) break;
      const text = `:fast_forward: *${esc(q.title)}:* ${decision === 'enough' ? 'skipped: the architect assumes its recommendation' : 'not answered yet'}`;
      await this.deps.api.updateMessage({ channel: task.slackChannel, ts: q.slackTs!, text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] });
    }
    const thread = await this.deps.thread(task);
    if (!thread) return;
    const note =
      decision === 'enough'
        ? `:memo: Enough questions: the architect writes the ${this.splitting(taskId) ? 'milestone split' : 'plan'} now.`
        : decision === 'send'
          ? ':envelope: Sent your answers so far to the architect.'
          : ':envelope: All answered: sent to the architect.';
    await this.deps.api.postMessage({ channel: thread.channel, thread_ts: thread.ts, text: note });
  }

  // ------------------------------------------------------------ incoming

  /**
   * A tap on a question button. Only the owner's taps count. Returns a short note to show when it
   * couldn't be done (already answered on the board, round closed).
   */
  async onButton(user: string | undefined, actionId: string): Promise<string | null> {
    if (user !== this.deps.ownerId) return null;
    const m = actionId.match(QUESTION_ACTION);
    if (!m) return null;
    const q = this.deps.db.select().from(schema.questions).where(eq(schema.questions.id, Number(m[1]))).get();
    if (!q) return 'That question no longer exists.';
    try {
      switch (m[2]) {
        case 'rec':
          if (!q.recommended) return 'This question has no recommendation.';
          this.deps.pipeline.answerQuestion(q.id, { text: q.recommended }, 'slack');
          break;
        case 'decide':
          this.deps.pipeline.answerQuestion(q.id, { delegate: true }, 'slack');
          break;
        case 'send':
        case 'enough':
          this.deps.pipeline.briefingAction(q.taskId, m[2]);
          break;
        default: {
          const option = q.options[Number(m[3])];
          if (option === undefined) return 'That option no longer exists.';
          this.deps.pipeline.answerQuestion(q.id, { text: option }, 'slack');
        }
      }
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  /** The open question of a task that a typed answer would be for: the one posted in Slack. */
  openQuestion(taskId: number): Question | undefined {
    const pending = this.deps.db.select().from(schema.gates).where(and(eq(schema.gates.taskId, taskId), eq(schema.gates.kind, 'question'), eq(schema.gates.status, 'pending'))).get();
    if (!pending) return undefined;
    return this.roundQuestions(pending.id).find((q) => q.answer === null && !q.delegated && q.slackTs);
  }
}
