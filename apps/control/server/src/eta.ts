// How long a task has left, worked out in code so Fury reports it and never makes one up.
//
// The journey of a task is the agent steps its lane still has to run, with the human gates between
// them. The time left is the median duration of recent successful runs of each (lane, step), less
// what the current step has already taken, summed over the steps still to come. Gates aren't timed:
// the answer says "then it waits for you" instead, because that wait is the owner's, not the office's.

import { and, desc, eq } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { schema } from './db/index.js';
import type { Task } from './db/schema.js';
import { isSolo, type TaskStatus } from './domain.js';

type LaneKey = 'solo' | 'standard';
type Item = { agent: TaskStatus } | { gate: string };

/** Successful runs looked at per (lane, step), newest first. */
const RECENT_RUNS = 20;
/** Fewer runs than this is too little to trust: the default is used instead. */
const MIN_SAMPLES = 3;

const MIN = 60_000;
/** Rough durations until the office has run enough tasks of a lane to know its own. */
const DEFAULT_MS: Record<LaneKey, Partial<Record<TaskStatus, number>>> = {
  solo: { queued: MIN, intake: MIN, coding: 15 * MIN, reviewing: 4 * MIN, retro: MIN },
  standard: { queued: MIN, intake: MIN, debugging: 5 * MIN, researching: 4 * MIN, planning: 6 * MIN, splitting: 6 * MIN, coding: 10 * MIN, reviewing: 4 * MIN, testing: 5 * MIN, reviewing_pr: 5 * MIN, retro: MIN },
};
const FALLBACK_MS = 5 * MIN;

export const laneKey = (task: Pick<Task, 'lane'>): LaneKey => (isSolo(task) ? 'solo' : 'standard');

/** The median of recent successful runs of this step for tasks of this lane, with how many runs it rests on. */
export function medianStep(db: Db, lane: LaneKey, step: TaskStatus): { ms: number; samples: number } | null {
  const rows = db
    .select({ durationMs: schema.runs.durationMs, lane: schema.tasks.lane })
    .from(schema.runs)
    .innerJoin(schema.tasks, eq(schema.runs.taskId, schema.tasks.id))
    .where(and(eq(schema.runs.status, 'ok'), eq(schema.runs.step, step)))
    .orderBy(desc(schema.runs.id))
    .limit(RECENT_RUNS * 6)
    .all()
    .filter((r) => r.durationMs !== null && r.durationMs > 0 && laneKey({ lane: r.lane }) === lane)
    .slice(0, RECENT_RUNS)
    .map((r) => r.durationMs as number)
    .sort((a, b) => a - b);
  if (!rows.length) return null;
  const mid = Math.floor(rows.length / 2);
  return { ms: rows.length % 2 ? rows[mid]! : Math.round((rows[mid - 1]! + rows[mid]!) / 2), samples: rows.length };
}

const GATE_FOR_STATUS: Partial<Record<TaskStatus, string>> = {
  awaiting_plan_approval: 'plan approval',
  awaiting_breakdown_approval: 'milestone approval',
  awaiting_push_approval: 'merge',
  pr_open: 'merge',
  awaiting_merge_approval: 'merge',
  pushing: 'merge',
  awaiting_review_post: 'review post',
};

/** The status the task is really at: a paused, blocked or stopped task sits where it will resume. */
function placeOf(task: Task): TaskStatus | null {
  return ['paused', 'blocked', 'stopped'].includes(task.status) ? task.resumeStatus : task.status;
}

/** The agent steps and gates this task still has to go through, from the start of its lane. */
function journey(task: Task, at: TaskStatus, reviewAdded: boolean): Item[] {
  if (task.kind === 'review') return [{ agent: 'reviewing_pr' }, { gate: 'review post' }];
  if (at === 'splitting' || at === 'awaiting_breakdown_approval') return [{ agent: 'splitting' }, { gate: 'milestone approval' }];
  if (laneKey(task) === 'solo') {
    // A solo change is reviewed once only when it is big; whether it is isn't known until it's built.
    return [{ agent: 'intake' }, { agent: 'coding' }, ...(reviewAdded || at === 'reviewing' ? [{ agent: 'reviewing' as const }] : []), { gate: 'merge' }, { agent: 'retro' }];
  }
  return [
    { agent: 'intake' },
    ...(task.needsDebugger || at === 'debugging' ? [{ agent: 'debugging' as const }] : []),
    ...(task.needsResearcher || at === 'researching' ? [{ agent: 'researching' as const }] : []),
    { agent: 'planning' },
    { gate: 'plan approval' },
    { agent: 'coding' },
    { agent: 'reviewing' },
    { agent: 'testing' },
    { gate: 'merge' },
    { agent: 'retro' },
  ];
}

export interface Eta {
  /** Agent time left, not counting any wait for the owner. */
  remainingMs: number;
  /** The agent steps still to run, in order, including the one running now. */
  steps: TaskStatus[];
  /** What the owner still has to decide along the way ("merge", "plan approval"). */
  gates: string[];
  /** Whether the task is waiting on the owner right now. */
  waitingNow: boolean;
  /** Where the numbers come from: this office's recent runs, built-in defaults, or both. */
  basis: 'history' | 'defaults' | 'mixed';
  /** The current step has already run longer than usual. */
  overrun: boolean;
  /** Paused, blocked or stopped: the time is what's left once it runs again. */
  halted: boolean;
}

/**
 * The time left on a task, or null when there's nothing to predict (finished, or stopped with
 * nowhere to resume from). `stepElapsedMs` is how long the current agent step has run.
 */
export function estimateRemaining(db: Db, task: Task, stepElapsedMs: number): Eta | null {
  const at = placeOf(task);
  if (!at || ['done', 'failed', 'discarded'].includes(at)) return null;
  const reviewAdded = db
    .select({ id: schema.events.id })
    .from(schema.events)
    .where(and(eq(schema.events.taskId, task.id), eq(schema.events.type, 'review_added')))
    .get() !== undefined;
  const path = journey(task, at, reviewAdded);

  // Where in the journey the task is. A parked briefing hasn't started its step, and waits on answers.
  let cursor: number;
  const gateName = GATE_FOR_STATUS[at];
  const extraGates: string[] = [];
  if (gateName) cursor = path.findIndex((i) => 'gate' in i && i.gate === gateName);
  else if (at === 'awaiting_answer') {
    cursor = path.findIndex((i) => 'agent' in i && (i.agent === 'planning' || i.agent === 'splitting'));
    extraGates.push('your answers');
  } else if (at === 'merging' || at === 'posting_review') cursor = path.findIndex((i) => 'agent' in i && i.agent === 'retro');
  else if (at === 'queued') cursor = 0;
  else cursor = path.findIndex((i) => 'agent' in i && i.agent === at);
  if (cursor < 0) return null;

  const lane = laneKey(task);
  const sources = new Set<'history' | 'defaults'>();
  const usual = (step: TaskStatus): number => {
    const seen = medianStep(db, lane, step);
    if (seen && seen.samples >= MIN_SAMPLES) {
      sources.add('history');
      return seen.ms;
    }
    sources.add('defaults');
    return DEFAULT_MS[lane][step] ?? FALLBACK_MS;
  };

  const steps: TaskStatus[] = [];
  const gates = [...extraGates];
  let remainingMs = 0;
  let overrun = false;
  path.slice(cursor).forEach((item, i) => {
    if ('gate' in item) return void gates.push(item.gate);
    steps.push(item.agent);
    const total = usual(item.agent);
    // Only the step that is running now has a clock on it.
    const running = i === 0 && item.agent === at && !['queued', 'awaiting_answer'].includes(task.status);
    if (running && stepElapsedMs > total) overrun = true;
    remainingMs += running ? Math.max(0, total - stepElapsedMs) : total;
  });
  return {
    remainingMs,
    steps,
    gates,
    waitingNow: 'gate' in path[cursor]! || at === 'awaiting_answer',
    basis: sources.size === 2 ? 'mixed' : sources.has('history') ? 'history' : 'defaults',
    overrun,
    halted: ['paused', 'blocked', 'stopped'].includes(task.status),
  };
}

/** "about 12m", "about 1h 10m", "under a minute": rounded, because it is an estimate. */
export function roughDuration(ms: number): string {
  const minutes = Math.round(ms / MIN);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `about ${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `about ${h}h${m ? ` ${m}m` : ''}`;
}

const STEP_WORD: Partial<Record<TaskStatus, string>> = {
  intake: 'sizing it up',
  debugging: 'finding the cause',
  researching: 'research',
  planning: 'the plan',
  splitting: 'the milestone split',
  coding: 'the build',
  reviewing: 'review',
  testing: 'tests',
  reviewing_pr: 'the review',
  retro: 'wrap-up',
};

/** The ETA as one or two plain lines. */
export function formatEta(eta: Eta): string {
  const waits = eta.gates.length ? ` Then it waits for you: ${eta.gates.join(', then ')}.` : '';
  const words = eta.steps.map((s) => STEP_WORD[s] ?? s.replace(/_/g, ' '));
  if (!eta.steps.length) return `Nothing left for the agents to do.${waits}`;
  const basis = eta.basis === 'history' ? "from this office's recent runs" : eta.basis === 'mixed' ? 'partly from recent runs, partly a default' : 'a default guess: too few runs to go by yet';
  const halted = eta.halted ? ' once it runs again' : '';
  const over = eta.overrun ? ' The current step is already running longer than usual.' : '';
  return `ETA: ${roughDuration(eta.remainingMs)} of agent work left${halted} (${words.join(', ')}; ${basis}).${waits}${over}`;
}
