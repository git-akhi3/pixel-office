import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, schema, type Db } from '../server/src/db/index.js';
import type { Task } from '../server/src/db/schema.js';
import { buildDeskTools, OWNER_ONLY_TOOLS, type DeskToolContext } from '../server/src/furyTools.js';
import { heroByName, heroForRole, HEROES } from '../server/src/heroes.js';
import type { Pipeline } from '../server/src/pipeline.js';
import type { StatusContext } from '../server/src/slackStatus.js';

const NOW = 1_000_000_000_000;

function setup(sender: 'owner' | 'assistant' = 'owner') {
  const db: Db = openDb(join(mkdtempSync(join(tmpdir(), 'furytools-')), 'office.db'));
  const repo = db.insert(schema.repos).values({ name: 'alpha', path: '/tmp/alpha', defaultBranch: 'main' }).returning().get();
  const add = (v: Partial<Task> = {}) => db.insert(schema.tasks).values({ repoId: repo.id, title: 'Add greeting', input: 'x', createdAt: NOW - 600_000, updatedAt: NOW - 120_000, ...v }).returning().get();

  const calls: string[] = [];
  const state = { running: true, steerAnswer: 'live' as 'live' | 'next_step' };
  const pipeline = {
    getTask: (id: number) => {
      const t = db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
      if (!t) throw new Error(`No task ${id}`);
      return t;
    },
    isRunning: () => state.running,
    pendingGates: (id?: number) => db.select().from(schema.gates).where(eq(schema.gates.status, 'pending')).all().filter((g) => id === undefined || g.taskId === id),
    tokensUsed: () => 0,
    steer: (id: number, text: string) => (calls.push(`steer:${id}:${text}`), state.steerAnswer),
    leaveNote: (id: number, text: string) => void calls.push(`note:${id}:${text}`),
    action: async (id: number, a: string) => void calls.push(`action:${id}:${a}`),
    decideGate: async (id: number, d: string, comment?: string) => void calls.push(`gate:${id}:${d}:${comment ?? ''}`),
    replanNow: (id: number, why: string) => void calls.push(`replan:${id}:${why}`),
    briefingAction: (id: number, a: string) => void calls.push(`briefing:${id}:${a}`),
    answerQuestion: (id: number, a: { text?: string; delegate?: boolean }) => void calls.push(`answer:${id}:${a.text ?? 'delegate'}`),
  } as unknown as Pipeline;
  const status: StatusContext = {
    db,
    now: NOW,
    publicUrl: 'http://127.0.0.1:4100',
    tokensUsed: () => 0,
    pendingGates: (id) => pipeline.pendingGates(id),
    stepStartedAt: () => undefined,
  };
  const hostCalls: string[] = [];
  const ctx: DeskToolContext = {
    sender,
    db,
    pipeline,
    status,
    host: {
      startTask: async (a) => (hostCalls.push(`start:${JSON.stringify(a)}`), 'Started #1.'),
      reviewPr: async (url) => (hostCalls.push(`review:${url}`), 'Reviewing.'),
      expectHeroReply: (id, role) => void hostCalls.push(`expect:${id}:${role}`),
    },
  };
  const tools = () => buildDeskTools(ctx);
  const run = (name: string, args: Record<string, unknown> = {}) => {
    const t = tools().find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t.run(args);
  };
  return { db, repo, add, calls, hostCalls, state, ctx, tools, run };
}

describe('who gets which tools', () => {
  it('gives the owner every tool, and an assistant none of the owner-only ones', () => {
    const owner = setup('owner').tools().map((t) => t.name);
    const assistant = setup('assistant').tools().map((t) => t.name);
    for (const name of OWNER_ONLY_TOOLS) {
      expect(owner).toContain(name);
      expect(assistant).not.toContain(name);
    }
    expect(assistant.sort()).toEqual(['list_repos', 'list_tasks', 'pause', 'resume', 'review_pr', 'start_task', 'steer', 'stop', 'task_status']);
  });

  it('refuses an owner-only tool if the sender is no longer the owner when it runs, and changes nothing', async () => {
    const t = setup('owner');
    const task = t.add({ status: 'awaiting_merge_approval' });
    const gate = t.db.insert(schema.gates).values({ taskId: task.id, kind: 'merge' }).returning().get();
    const q = t.db.insert(schema.questions).values({ taskId: task.id, round: 1, idx: 0, title: 'Q', body: 'b', recommended: 'r' }).returning().get();
    const owned = t.tools(); // built for the owner...
    t.ctx.sender = 'assistant'; // ...but run on behalf of someone else
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['approve', { gate: gate.id }],
      ['reject', { gate: gate.id, comment: 'no' }],
      ['discard', { task: task.id }],
      ['done', { task: task.id }],
      ['replan', { task: task.id, reason: 'again' }],
      ['answer_question', { question: q.id, answer: 'x' }],
      ['briefing_action', { task: task.id, action: 'enough' }],
    ];
    for (const [name, args] of attempts) {
      await expect(owned.find((x) => x.name === name)!.run(args), name).rejects.toThrow('Only the owner can');
    }
    expect(t.calls).toEqual([]);
  });

  it('lets an assistant pause, resume, steer and start tasks (how many is the bridge\'s limit)', async () => {
    const t = setup('assistant');
    const task = t.add({ status: 'coding' });
    await t.run('pause', { task: task.id });
    await t.run('resume', { task: task.id });
    await t.run('steer', { task: task.id, note: 'keep it small' });
    await t.run('start_task', { request: 'a thing' });
    expect(t.calls).toEqual([`action:${task.id}:stop`, `action:${task.id}:resume`, `steer:${task.id}:keep it small`]);
    expect(t.hostCalls.at(-1)).toContain('"lane":"auto"');
  });
});

describe('gates', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it("approves and rejects a waiting gate, with the owner's words as the comment", async () => {
    const task = t.add({ status: 'awaiting_plan_approval' });
    const gate = t.db.insert(schema.gates).values({ taskId: task.id, kind: 'plan' }).returning().get();
    expect(await t.run('approve', { gate: gate.id })).toContain('Approved the plan gate');
    expect(await t.run('reject', { gate: gate.id, comment: 'smaller scope' })).toContain('Sent the plan back');
    expect(t.calls).toEqual([`gate:${gate.id}:approve:`, `gate:${gate.id}:reject:smaller scope`]);
  });

  it("leaves command prompts to their buttons and the architect's questions to answer_question", async () => {
    const task = t.add();
    const command = t.db.insert(schema.gates).values({ taskId: task.id, kind: 'command', subject: 'npm test' }).returning().get();
    const question = t.db.insert(schema.gates).values({ taskId: task.id, kind: 'question' }).returning().get();
    const decided = t.db.insert(schema.gates).values({ taskId: task.id, kind: 'merge', status: 'approved' }).returning().get();
    await expect(t.run('approve', { gate: command.id })).rejects.toThrow('buttons');
    await expect(t.run('approve', { gate: question.id })).rejects.toThrow('answer_question');
    await expect(t.run('approve', { gate: decided.id })).rejects.toThrow('already decided');
    await expect(t.run('approve', { gate: 999 })).rejects.toThrow('no gate 999');
    expect(t.calls).toEqual([]);
  });

  it("answers the architect's question in the owner's words, with the recommendation, or by leaving it to the architect", async () => {
    const task = t.add({ status: 'planning' });
    const mk = (recommended: string | null) => t.db.insert(schema.questions).values({ taskId: task.id, round: 1, idx: 0, title: 'Stock', body: 'b', recommended }).returning().get();
    const a = mk('Per variant');
    const b = mk(null);
    const c = mk(null);
    await t.run('answer_question', { question: a.id, choice: 'recommended' });
    await t.run('answer_question', { question: b.id, choice: 'you_decide' });
    await t.run('answer_question', { question: c.id, answer: ' Shared ' });
    await expect(t.run('answer_question', { question: c.id, choice: 'recommended' })).rejects.toThrow('no recommendation');
    await expect(t.run('answer_question', { question: c.id })).rejects.toThrow('Give the owner');
    expect(t.calls).toEqual([`answer:${a.id}:Per variant`, `answer:${b.id}:delegate`, `answer:${c.id}:Shared`]);
  });

  it('discards, finishes and re-plans for the owner', async () => {
    const task = t.add();
    await t.run('discard', { task: task.id });
    await t.run('done', { task: task.id });
    await t.run('replan', { task: task.id, reason: 'wrong approach' });
    await t.run('briefing_action', { task: task.id, action: 'enough' });
    expect(t.calls).toEqual([`action:${task.id}:discard`, `action:${task.id}:done`, `replan:${task.id}:wrong approach`, `briefing:${task.id}:enough`]);
  });
});

describe('steering a hero', () => {
  it('reaches the hero who is working, live, and expects their first words', async () => {
    const t = setup();
    const task = t.add({ status: 'coding', frontend: true });
    expect(await t.run('steer', { task: task.id, hero: 'Loki', note: 'use the shared button' })).toContain('Sent to Loki now');
    expect(t.calls).toEqual([`steer:${task.id}:use the shared button`]);
    expect(t.hostCalls).toEqual([`expect:${task.id}:ui-coder`]);
  });

  it('steers whoever is working when no hero is named', async () => {
    const t = setup();
    const task = t.add({ status: 'coding', lane: 'solo' });
    expect(await t.run('steer', { task: task.id, note: 'skip the docs' })).toContain('Captain America');
    expect(t.hostCalls).toEqual([`expect:${task.id}:all-rounder`]);
  });

  it("keeps a note for a hero who isn't working, and never interrupts the one who is", async () => {
    const t = setup();
    const task = t.add({ status: 'coding' });
    const out = await t.run('steer', { task: task.id, hero: 'thor', note: 'check the empty case' });
    expect(out).toContain("Thor isn't working");
    expect(out).toContain('Iron Man is');
    expect(t.calls).toEqual([`note:${task.id}:For Thor (reviewer), when they next work on this: check the empty case`]);
    expect(t.hostCalls).toEqual([]);
  });

  it('keeps it for the next run when nothing is running, or when the hero cannot be reached now', async () => {
    const t = setup();
    const waiting = t.add({ status: 'awaiting_plan_approval' });
    expect(await t.run('steer', { task: waiting.id, hero: 'Strange', note: 'x' })).toContain('saved for their next run');
    expect(t.calls[0]).toContain('note:');
    const task = t.add({ status: 'coding', frontend: true });
    t.state.steerAnswer = 'next_step';
    expect(await t.run('steer', { task: task.id, hero: 'Loki', note: 'y' })).toContain('saved for the next step');
    expect(t.hostCalls).toEqual([]);
  });

  it('rejects a hero that does not exist, naming the team', async () => {
    const t = setup();
    const task = t.add();
    await expect(t.run('steer', { task: task.id, hero: 'Batman', note: 'x' })).rejects.toThrow('No hero called "Batman"');
    expect(t.calls).toEqual([]);
  });

  it('knows every hero by name, nickname and role', () => {
    expect(heroByName('Cap')?.role).toBe('all-rounder');
    expect(heroByName('Dr. Strange')?.role).toBe('architect');
    expect(heroByName('iron man')?.role).toBe('coder');
    expect(heroByName('ui-coder')?.name).toBe('Loki');
    expect(heroByName('Hawkeye,')?.role).toBe('verifier');
    expect(heroByName('nobody')).toBeUndefined();
    expect(HEROES.map((h) => h.name)).toEqual(['Fury', 'Doctor Strange', 'Iron Man', 'Loki', 'Captain America', 'Thor', 'Hulk', 'Black Widow', 'Vision', 'Hawkeye']);
    expect(heroForRole('manager')?.name).toBe('Fury');
  });
});

describe('reading state', () => {
  it('reports a task in detail: the hero working, the waiting gate and the ETA', async () => {
    const t = setup();
    const task = t.add({ status: 'reviewing', lane: 'standard' });
    const text = await t.run('task_status', { task: task.id });
    expect(text).toContain('Thor (reviewer) working');
    expect(text).toContain('ETA:');
    const waiting = t.add({ status: 'awaiting_merge_approval' });
    const gate = t.db.insert(schema.gates).values({ taskId: waiting.id, kind: 'merge' }).returning().get();
    expect(await t.run('task_status', { task: waiting.id })).toContain(`merge the PR, or send it back with what to change (gate ${gate.id})`);
    await expect(t.run('task_status', { task: 999 })).rejects.toThrow('No task 999');
  });

  it('lists repos and active tasks', async () => {
    const t = setup();
    t.add({ status: 'coding', title: 'Building' });
    t.add({ status: 'done', title: 'Finished' });
    expect(await t.run('list_repos')).toBe('alpha (branch main)');
    const list = await t.run('list_tasks');
    expect(list).toContain('Building');
    expect(list).not.toContain('Finished');
  });

  it('checks tool inputs before anything runs', async () => {
    const t = setup();
    await expect(t.run('start_task', { request: '' })).rejects.toThrow();
    await expect(t.run('pause', { task: 'twelve' })).rejects.toThrow();
    expect(t.hostCalls).toEqual([]);
  });
});
