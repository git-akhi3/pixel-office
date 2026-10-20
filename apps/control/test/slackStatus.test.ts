import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, schema, type Db } from '../server/src/db/index.js';
import type { Gate, Task } from '../server/src/db/schema.js';
import { describeTask, listActive, stageOf, waitingOnYou, type StatusContext } from '../server/src/slackStatus.js';

const NOW = 1_000_000_000_000;

function setup() {
  const db: Db = openDb(join(mkdtempSync(join(tmpdir(), 'slackstatus-')), 'office.db'));
  const repo = db.insert(schema.repos).values({ name: 'alpha', path: '/tmp/alpha', defaultBranch: 'main' }).returning().get();
  const add = (v: Partial<Task>) =>
    db.insert(schema.tasks).values({ repoId: repo.id, title: 'Task', input: 'x', createdAt: NOW - 10 * 60_000, updatedAt: NOW - 2 * 60_000, ...v }).returning().get();
  const gate = (taskId: number, kind: Gate['kind'], subject: string | null = null) => db.insert(schema.gates).values({ taskId, kind, subject }).returning().get();
  const ctx = (over: Partial<StatusContext> = {}): StatusContext => ({
    db,
    now: NOW,
    publicUrl: 'http://127.0.0.1:4100',
    tokensUsed: (_id, steps) => (steps ? 12_000 : 39_000),
    pendingGates: (id) => db.select().from(schema.gates).where(eq(schema.gates.status, 'pending')).all().filter((g) => g.taskId === id),
    stepStartedAt: () => undefined,
    ...over,
  });
  return { db, repo, add, gate, ctx };
}

describe('stageOf', () => {
  it('places each status in the pipeline and keeps a blocked task where it will resume', () => {
    const { add } = setup();
    expect(stageOf(add({ status: 'queued' }))).toEqual({ n: 1, of: 12 });
    expect(stageOf(add({ status: 'coding' }))).toEqual({ n: 5, of: 12 });
    expect(stageOf(add({ status: 'debugging' }))?.n).toBe(3);
    expect(stageOf(add({ status: 'blocked', resumeStatus: 'testing' }))?.n).toBe(7);
    expect(stageOf(add({ status: 'reviewing_pr', kind: 'review' }))).toEqual({ n: 2, of: 5 });
  });

  it('counts only the stages a lane runs', () => {
    const { add } = setup();
    expect(stageOf(add({ status: 'coding', lane: 'solo' }))).toEqual({ n: 3, of: 9 });
    expect(stageOf(add({ status: 'awaiting_merge_approval', lane: 'solo' }))).toEqual({ n: 6, of: 9 });
    expect(stageOf(add({ status: 'reviewing', lane: 'small' }))).toEqual({ n: 4, of: 9 });
    expect(stageOf(add({ status: 'testing', lane: 'standard' }))).toEqual({ n: 7, of: 12 });
  });
});

describe('waitingOnYou', () => {
  it('says what needs the owner, and nothing while the office works alone', () => {
    const { add, gate } = setup();
    expect(waitingOnYou(add({ status: 'coding' }), [])).toBeNull();
    expect(waitingOnYou(add({ status: 'awaiting_plan_approval' }), [])).toContain('plan');
    expect(waitingOnYou(add({ status: 'awaiting_push_approval' }), [])).toContain('push');
    expect(waitingOnYou(add({ status: 'awaiting_merge_approval' }), [])).toContain('merge the PR');
    expect(waitingOnYou(add({ status: 'blocked' }), [])).toContain('unblock');
    const t = add({ status: 'coding' });
    expect(waitingOnYou(t, [gate(t.id, 'command', 'rm -rf build')])).toContain('rm -rf build');
  });
});

describe('describeTask', () => {
  it('shows stage, time, spend against the estimate, and what is waiting', () => {
    const { add, ctx, gate } = setup();
    const t = add({ status: 'awaiting_merge_approval', title: 'Add greeting', tokenEstimate: 15_000, prUrl: null });
    gate(t.id, 'merge');
    const text = describeTask(t, ctx());
    expect(text).toContain('*#' + t.id + '* Add greeting');
    expect(text).toContain('stage 9 of 12');
    expect(text).toContain('10m 0s since it started');
    expect(text).toContain('39.0k tokens used');
    expect(text).toContain('12.0k of the plan\'s ~15.0k estimate (80%)');
    expect(text).toContain('*Waiting on you:* merge the PR');
    // At the merge gate only the wrap-up is left for the agents; the merge itself waits for the owner.
    expect(text).toContain('ETA: about 1m of agent work left (wrap-up');
    expect(text).toContain('Then it waits for you: merge.');
    expect(text).not.toContain('No time estimate');
    expect(text).toContain(`(gate`);
  });

  it('shows the working agent and step time, and the last alert when blocked', () => {
    const { add, db, ctx } = setup();
    const working = add({ status: 'coding' });
    const text = describeTask(working, ctx({ stepStartedAt: () => NOW - 90_000 }));
    expect(text).toContain('Iron Man (coder) working');
    expect(text).toContain('1m 30s in this step');
    expect(text).toContain('Nothing waiting on you');
    // A standard task in coding still has review and tests to go, then the merge waits for the owner.
    expect(text).toContain('ETA: about 19m of agent work left (the build, review, tests, wrap-up');
    expect(text).toContain('Then it waits for you: merge.');

    const blocked = add({ status: 'blocked', resumeStatus: 'coding', statusNote: 'Push failed' });
    db.insert(schema.events).values({ taskId: blocked.id, type: 'alert', payload: { kind: 'blocked', message: 'No <origin> remote' } }).run();
    const b = describeTask(blocked, ctx());
    expect(b).toContain('Note: Push failed');
    expect(b).toContain('Last alert: No &lt;origin&gt; remote');
  });
});

describe('listActive', () => {
  it('lists unfinished tasks with what is waiting, and skips finished ones', () => {
    const { add, ctx } = setup();
    add({ status: 'done', title: 'Old' });
    add({ status: 'discarded', title: 'Dropped' });
    const a = add({ status: 'coding', title: 'Building', slackChannel: 'C0X', slackThreadTs: '100.5' });
    add({ status: 'awaiting_plan_approval', title: 'Needs approval' });
    const text = listActive(ctx());
    expect(text).toContain('*2 active tasks*, 1 waiting on you');
    expect(text).toContain(`*#${a.id}* Building`);
    expect(text).toContain('slack.com/archives/C0X/p1005');
    expect(text).toContain('approve or reject the plan');
    expect(text).not.toContain('Old');
    expect(text).not.toContain('Dropped');
  });

  it('says so when nothing is active', () => {
    const { add, ctx } = setup();
    add({ status: 'done' });
    expect(listActive(ctx())).toBe('No active tasks.');
  });
});
