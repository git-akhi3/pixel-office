import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb, schema, type Db } from '../server/src/db/index.js';
import type { Run, Task } from '../server/src/db/schema.js';
import { estimateRemaining, formatEta, medianStep, roughDuration } from '../server/src/eta.js';

const MIN = 60_000;

function setup() {
  const db: Db = openDb(join(mkdtempSync(join(tmpdir(), 'eta-')), 'office.db'));
  const repo = db.insert(schema.repos).values({ name: 'alpha', path: '/tmp/alpha' }).returning().get();
  const task = (v: Partial<Task> = {}) => db.insert(schema.tasks).values({ repoId: repo.id, title: 'T', input: 'x', ...v }).returning().get();
  /** A finished run of a step on a task of the given lane, taking `minutes`. */
  const run = (lane: Task['lane'], step: Run['step'], minutes: number, status: Run['status'] = 'ok') => {
    const t = task({ lane, status: 'done' });
    db.insert(schema.runs).values({ taskId: t.id, role: 'coder', step, model: 'm', status, durationMs: minutes * MIN }).run();
  };
  return { db, task, run };
}

describe('medianStep', () => {
  it('is the median of recent successful runs of that lane and step', () => {
    const { db, run } = setup();
    [4, 10, 6].forEach((m) => run('solo', 'coding', m));
    run('solo', 'coding', 99, 'failed'); // failed runs say nothing about how long a step takes
    run('standard', 'coding', 50); // another lane
    expect(medianStep(db, 'solo', 'coding')).toEqual({ ms: 6 * MIN, samples: 3 });
    run('solo', 'coding', 8);
    expect(medianStep(db, 'solo', 'coding')).toEqual({ ms: 7 * MIN, samples: 4 });
    expect(medianStep(db, 'solo', 'reviewing')).toBeNull();
  });

  it('treats old trivial and small tasks as solo, and tasks with no lane as standard', () => {
    const { db, run } = setup();
    run('small', 'coding', 5);
    run(null, 'coding', 20);
    expect(medianStep(db, 'solo', 'coding')?.ms).toBe(5 * MIN);
    expect(medianStep(db, 'standard', 'coding')?.ms).toBe(20 * MIN);
  });

  it('looks only at the newest runs', () => {
    const { db, run } = setup();
    for (let i = 0; i < 20; i++) run('solo', 'coding', 100); // old and slow
    for (let i = 0; i < 20; i++) run('solo', 'coding', 5);
    expect(medianStep(db, 'solo', 'coding')?.ms).toBe(5 * MIN);
  });
});

describe('estimateRemaining', () => {
  it('uses defaults while there are too few runs, less the time already spent in the step', () => {
    const { db, task } = setup();
    const t = task({ lane: 'solo', status: 'coding' });
    const eta = estimateRemaining(db, t, 5 * MIN)!;
    // coding 15m - 5m, then the wrap-up (1m); the merge waits for the owner.
    expect(eta).toMatchObject({ remainingMs: 11 * MIN, steps: ['coding', 'retro'], gates: ['merge'], waitingNow: false, basis: 'defaults', overrun: false, halted: false });
  });

  it('prefers the median of recent runs once there are enough', () => {
    const { db, task, run } = setup();
    [4, 6, 8].forEach((m) => run('solo', 'coding', m));
    const eta = estimateRemaining(db, task({ lane: 'solo', status: 'coding' }), 2 * MIN)!;
    expect(eta.remainingMs).toBe(4 * MIN + MIN); // 6m median less 2m, plus the default wrap-up
    expect(eta.basis).toBe('mixed');
    [1, 1, 1].forEach((m) => run('solo', 'retro', m));
    expect(estimateRemaining(db, task({ lane: 'solo', status: 'coding' }), 0)!.basis).toBe('history');
  });

  it('sums every step the full team still has, and lists the owner stops without timing them', () => {
    const { db, task } = setup();
    const eta = estimateRemaining(db, task({ lane: 'standard', status: 'planning' }), 0)!;
    expect(eta.steps).toEqual(['planning', 'coding', 'reviewing', 'testing', 'retro']);
    // Plans go ahead on their own: only a briefed task stops for plan approval.
    expect(eta.gates).toEqual(['merge']);
    expect(eta.remainingMs).toBe((6 + 10 + 4 + 5 + 1) * MIN);
    expect(estimateRemaining(db, task({ lane: 'standard', status: 'planning', grill: true }), 0)!.gates).toEqual(['plan approval', 'merge']);
  });

  it('adds the debugger and researcher only when the task needs them', () => {
    const { db, task } = setup();
    expect(estimateRemaining(db, task({ lane: 'standard', status: 'queued', needsDebugger: true, needsResearcher: true }), 0)!.steps.slice(0, 4)).toEqual(['intake', 'debugging', 'researching', 'planning']);
    expect(estimateRemaining(db, task({ lane: 'standard', status: 'queued' }), 0)!.steps.slice(0, 2)).toEqual(['intake', 'planning']);
  });

  it('counts a review on a solo task only when one was added', () => {
    const { db, task } = setup();
    const t = task({ lane: 'solo', status: 'coding' });
    expect(estimateRemaining(db, t, 0)!.steps).toEqual(['coding', 'retro']);
    db.insert(schema.events).values({ taskId: t.id, type: 'review_added', payload: {} }).run();
    expect(estimateRemaining(db, t, 0)!.steps).toEqual(['coding', 'reviewing', 'retro']);
  });

  it('is waiting on the owner at a gate: only what comes after it is timed', () => {
    const { db, task } = setup();
    const eta = estimateRemaining(db, task({ lane: 'standard', status: 'awaiting_plan_approval' }), 0)!;
    expect(eta).toMatchObject({ waitingNow: true, steps: ['coding', 'reviewing', 'testing', 'retro'], gates: ['plan approval', 'merge'] });
    expect(estimateRemaining(db, task({ lane: 'solo', status: 'awaiting_merge_approval' }), 0)).toMatchObject({ waitingNow: true, steps: ['retro'], gates: ['merge'] });
  });

  it('says so when the current step has run longer than usual, without a negative time', () => {
    const { db, task } = setup();
    const eta = estimateRemaining(db, task({ lane: 'solo', status: 'coding' }), 40 * MIN)!;
    expect(eta.overrun).toBe(true);
    expect(eta.remainingMs).toBe(MIN);
    expect(formatEta(eta)).toContain('already running longer than usual');
  });

  it('times a review task, an epic split and a paused task from where they will resume', () => {
    const { db, task } = setup();
    expect(estimateRemaining(db, task({ kind: 'review', status: 'reviewing_pr' }), 0)).toMatchObject({ steps: ['reviewing_pr'], gates: ['review post'] });
    expect(estimateRemaining(db, task({ lane: 'standard', status: 'splitting' }), 0)).toMatchObject({ steps: ['splitting'], gates: ['milestone approval'] });
    expect(estimateRemaining(db, task({ lane: 'solo', status: 'stopped', resumeStatus: 'coding' }), 0)).toMatchObject({ halted: true, steps: ['coding', 'retro'] });
    expect(estimateRemaining(db, task({ lane: 'standard', status: 'awaiting_answer' }), 0)!.gates[0]).toBe('your answers');
  });

  it('has nothing to say about a finished task or one with nowhere to resume', () => {
    const { db, task } = setup();
    expect(estimateRemaining(db, task({ status: 'done' }), 0)).toBeNull();
    expect(estimateRemaining(db, task({ status: 'discarded' }), 0)).toBeNull();
    expect(estimateRemaining(db, task({ status: 'blocked', resumeStatus: null }), 0)).toBeNull();
  });
});

describe('formatEta', () => {
  it('reports the time, where it comes from and what waits on the owner', () => {
    const { db, task } = setup();
    const text = formatEta(estimateRemaining(db, task({ lane: 'solo', status: 'coding' }), 0)!);
    expect(text).toBe('ETA: about 16m of agent work left (the build, wrap-up; a default guess: too few runs to go by yet). Then it waits for you: merge.');
  });

  it('says there is nothing for the agents when only the owner is left', () => {
    expect(formatEta({ remainingMs: 0, steps: [], gates: ['merge'], waitingNow: true, basis: 'history', overrun: false, halted: false })).toBe('Nothing left for the agents to do. Then it waits for you: merge.');
  });

  it('rounds to minutes', () => {
    expect(roughDuration(20_000)).toBe('under a minute');
    expect(roughDuration(12 * MIN + 20_000)).toBe('about 12m');
    expect(roughDuration(70 * MIN)).toBe('about 1h 10m');
    expect(roughDuration(120 * MIN)).toBe('about 2h');
  });
});
