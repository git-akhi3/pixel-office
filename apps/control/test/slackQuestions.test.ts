import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { openDb, schema, type Db } from '../server/src/db/index.js';
import type { Task } from '../server/src/db/schema.js';
import { EventBus } from '../server/src/events.js';
import { SlackQuestions } from '../server/src/slackQuestions.js';

const OWNER = 'U0OWNER0001';

function setup(step: 'planning' | 'splitting' = 'planning') {
  const db: Db = openDb(join(mkdtempSync(join(tmpdir(), 'slackq-')), 'office.db'));
  const bus = new EventBus(db);
  const repo = db.insert(schema.repos).values({ name: 'alpha', path: '/tmp/alpha' }).returning().get();
  const task = db.insert(schema.tasks).values({ repoId: repo.id, title: 'Add variants', input: 'x', status: 'planning', slackChannel: 'D1', slackThreadTs: '9.1' }).returning().get();
  const gate = db.insert(schema.gates).values({ taskId: task.id, kind: 'question', subject: 'Round 1: 2 questions' }).returning().get();
  const qs = db
    .insert(schema.questions)
    .values([
      { taskId: task.id, gateId: gate.id, round: 1, idx: 0, title: 'Stock', body: 'Shared or per variant?', options: ['Shared', 'Per variant'], recommended: 'Per variant' },
      { taskId: task.id, gateId: gate.id, round: 1, idx: 1, title: 'Pricing', body: 'Per variant price?', options: [], recommended: null },
    ])
    .returning()
    .all();

  const posted: Array<{ text: string; blocks?: unknown[]; ts: string }> = [];
  const updated: Array<{ ts: string; text: string }> = [];
  let n = 0;
  const calls: string[] = [];
  // A tiny stand-in for the pipeline: records answers like the real one, and emits the same events.
  const pipeline = {
    getTask: (id: number) => db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()! as Task,
    answerQuestion: (id: number, a: { text?: string; delegate?: boolean }, via: 'board' | 'slack') => {
      const q = db.select().from(schema.questions).where(eq(schema.questions.id, id)).get()!;
      if (q.answer !== null || q.delegated) throw new Error(`Already answered on ${q.answeredVia}.`);
      calls.push(`answer:${id}:${a.text ?? 'delegate'}:${via}`);
      const row = db.update(schema.questions).set({ answer: a.delegate ? null : a.text!, delegated: !!a.delegate, answeredVia: via }).where(eq(schema.questions.id, id)).returning().get();
      bus.emit(q.taskId, 'question_answered', { questionId: id, gateId: q.gateId, via });
      return row;
    },
    briefingStep: () => step,
    briefingAction: (taskId: number, action: string) => {
      calls.push(`briefing:${taskId}:${action}`);
      db.update(schema.gates).set({ status: 'approved' }).where(eq(schema.gates.id, gate.id)).run();
      bus.emit(taskId, 'gate_decided', { gateId: gate.id, kind: 'question', decision: action });
    },
  };
  const sq = new SlackQuestions({
    db,
    bus,
    pipeline: pipeline as never,
    ownerId: OWNER,
    publicUrl: 'http://127.0.0.1:4100',
    api: {
      postMessage: async (a) => {
        const ts = `100.${++n}`;
        posted.push({ ...a, ts });
        return { ts };
      },
      updateMessage: async (a) => void updated.push(a),
    },
    thread: async (t) => ({ channel: t.slackChannel!, ts: t.slackThreadTs! }),
  });
  sq.start();
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const actions = (i: number) => (posted[i]!.blocks as Array<{ type: string; elements?: Array<{ action_id: string; text: { text: string } }> }>).filter((b) => b.type === 'actions').flatMap((b) => b.elements!);
  return { db, bus, task, gate, qs, posted, updated, calls, sq, settle, actions };
}

describe('briefing questions in Slack', () => {
  it("says it will split, not plan, when it's an epic's briefing", async () => {
    const t = setup('splitting');
    t.bus.emit(t.task.id, 'question_round', { gateId: t.gate.id, round: 1, count: 2 });
    await t.settle();
    expect(t.actions(0).map((e) => e.text.text).at(-1)).toBe('Enough, split it now');
    t.bus.emit(t.task.id, 'gate_decided', { gateId: t.gate.id, kind: 'question', decision: 'enough' });
    await t.settle();
    expect(t.posted.at(-1)!.text).toContain('the architect writes the milestone split now');
  });

  it('posts one question at a time with the recommendation, options and round buttons', async () => {
    const t = setup();
    t.bus.emit(t.task.id, 'question_round', { gateId: t.gate.id, round: 1, count: 2 });
    await t.settle();
    expect(t.posted).toHaveLength(1);
    expect(t.actions(0).map((e) => e.text.text)).toEqual(['Lock it in', 'Shared', 'Per variant', 'You decide', 'Enough, start planning']);
    expect(JSON.stringify(t.posted[0]!.blocks)).toContain('Question 1 of 2');

    // Lock it in: answered with the recommendation, the message shows it, the next question follows.
    expect(await t.sq.onButton(OWNER, `office_q:${t.qs[0]!.id}:rec`)).toBeNull();
    await t.settle();
    expect(t.calls).toEqual([`answer:${t.qs[0]!.id}:Per variant:slack`]);
    expect(t.updated[0]!.text).toContain('*Stock:* Per variant');
    expect(t.posted).toHaveLength(2);
    // No recommendation and no options: only "you decide", plus "send" now that one is answered.
    expect(t.actions(1).map((e) => e.text.text)).toEqual(['You decide', "Send what I've answered", 'Enough, start planning']);
  });

  it('a thread reply answers the posted question; an answer on the board updates Slack', async () => {
    const t = setup();
    t.bus.emit(t.task.id, 'question_round', { gateId: t.gate.id });
    await t.settle();
    expect(t.sq.onThreadReply(t.task.id, 'Shared, like today')).toBe(true);
    await t.settle();
    expect(t.calls).toEqual([`answer:${t.qs[0]!.id}:Shared, like today:slack`]);
    // Q2 is answered on the board: Slack marks it, and nothing is waiting for a reply any more.
    (t.calls.length = 0);
    t.sq['deps'].pipeline.answerQuestion(t.qs[1]!.id, { text: 'Yes' }, 'board');
    await t.settle();
    expect(t.updated.at(-1)!.text).toContain('*Pricing:* Yes (on the board)');
    expect(t.sq.onThreadReply(t.task.id, 'stray reply')).toBe(false);
  });

  it('ignores taps from anyone but the owner, and explains a second answer', async () => {
    const t = setup();
    t.bus.emit(t.task.id, 'question_round', { gateId: t.gate.id });
    await t.settle();
    expect(await t.sq.onButton('U0STRANGER', `office_q:${t.qs[0]!.id}:rec`)).toBeNull();
    expect(t.calls).toEqual([]);
    await t.sq.onButton(OWNER, `office_q:${t.qs[0]!.id}:opt1`);
    expect(await t.sq.onButton(OWNER, `office_q:${t.qs[0]!.id}:opt0`)).toMatch(/Already answered/);
    expect(t.calls).toEqual([`answer:${t.qs[0]!.id}:Per variant:slack`]);
  });

  it('"Enough" closes the round: skipped questions say so and the thread hears it', async () => {
    const t = setup();
    t.bus.emit(t.task.id, 'question_round', { gateId: t.gate.id });
    await t.settle();
    await t.sq.onButton(OWNER, `office_q:${t.qs[0]!.id}:enough`);
    await t.settle();
    expect(t.calls).toEqual([`briefing:${t.task.id}:enough`]);
    expect(t.updated.at(-1)!.text).toContain('skipped');
    expect(t.posted.at(-1)!.text).toContain('the architect writes the plan now');
  });
});

describe('briefing questions through the bridge', () => {
  it('routes an owner reply in the task thread to the open question, and refuses an assistant', async () => {
    const { SlackBridge } = await import('../server/src/slack.js');
    const t = setup();
    const ASSISTANT = 'U0INSTINCT1';
    const CH = 'C0SHARED1';
    t.db.update(schema.tasks).set({ slackChannel: CH }).where(eq(schema.tasks.id, t.task.id)).run();
    const pipeline = {
      ...(t.sq['deps'].pipeline as object),
      pendingGates: () => [],
      tokensUsed: () => 0,
      briefingAction: (id: number, a: string) => void t.calls.push(`briefing:${id}:${a}`),
    };
    const bridge = new SlackBridge({
      db: t.db,
      bus: t.bus,
      pipeline: pipeline as never,
      docs: {} as never,
      ownerId: OWNER,
      channelId: CH,
      assistantIds: [ASSISTANT],
      publicUrl: 'http://127.0.0.1:4100',
      api: { postMessage: async () => ({ ts: '1.1' }), updateMessage: async () => undefined, openDm: async () => 'D1' },
    });
    t.sq.stop(); // the bridge brings its own question poster
    await bridge.start();
    t.bus.emit(t.task.id, 'question_round', { gateId: t.gate.id });
    await t.settle();
    await bridge.onMessage({ user: ASSISTANT, channel: CH, ts: '9.2', thread_ts: '9.1', text: 'Shared' });
    await bridge.onMessage({ user: ASSISTANT, channel: CH, ts: '9.3', thread_ts: '9.1', text: 'enough' });
    expect(t.calls).toEqual([]);
    await bridge.onMessage({ user: OWNER, channel: CH, ts: '9.4', thread_ts: '9.1', text: 'Per variant, with its own stock' });
    expect(t.calls).toEqual([`answer:${t.qs[0]!.id}:Per variant, with its own stock:slack`]);
    // An answer that starts with a command word is still an answer.
    t.calls.length = 0;
    t.bus.emit(t.task.id, 'question_answered', { questionId: t.qs[0]!.id, gateId: t.gate.id });
    await t.settle();
    await bridge.onMessage({ user: OWNER, channel: CH, ts: '9.41', thread_ts: '9.1', text: 'Discard the per-item price, use the variant price' });
    expect(t.calls).toEqual([`answer:${t.qs[1]!.id}:Discard the per-item price, use the variant price:slack`]);
    await bridge.onMessage({ user: OWNER, channel: CH, ts: '9.5', thread_ts: '9.1', text: 'send' });
    expect(t.calls.at(-1)).toBe(`briefing:${t.task.id}:send`);
    bridge.stop();
  });
});
