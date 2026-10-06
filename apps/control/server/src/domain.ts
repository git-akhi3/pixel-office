// Shared vocabulary for tasks, roles and gates.

export const ROLES = ['manager', 'architect', 'coder', 'reviewer', 'tester', 'debugger', 'researcher'] as const;
export type Role = (typeof ROLES)[number];

export const TASK_STATUSES = [
  'queued', // waiting for a slot to run intake
  'intake', // manager sizes and routes the task
  'debugging', // debugger finds the root cause (bugs flagged by intake)
  'researching', // researcher answers external questions (flagged by intake)
  'planning', // architect writes plan.md
  'awaiting_answer', // the architect's briefing question waited 15 minutes: parked until I answer
  'awaiting_plan_approval',
  'coding',
  'reviewing',
  'testing',
  'awaiting_push_approval',
  'pushing',
  'pr_open',
  'retro', // manager writes retro.md after done
  // PR review tasks
  'reviewing_pr', // reviewer drafts a review of someone's PR
  'awaiting_review_post', // I edit the draft comments, then post
  'posting_review',
  'done',
  'blocked', // needs me: loops exhausted or an agent is stuck
  'paused', // rate limit or server restart; resume restarts resume_status
  'stopped', // I stopped it; worktree kept
  'failed',
  'discarded',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Statuses where an agent does work. These need a concurrency slot. */
export const AGENT_STEPS: Record<string, Role> = {
  queued: 'manager',
  intake: 'manager',
  debugging: 'debugger',
  researching: 'researcher',
  planning: 'architect',
  coding: 'coder',
  reviewing: 'reviewer',
  testing: 'tester',
  retro: 'manager',
  reviewing_pr: 'reviewer',
};

export function isAgentStep(status: TaskStatus): boolean {
  return status in AGENT_STEPS;
}

export const TERMINAL_STATUSES: TaskStatus[] = ['done', 'failed', 'discarded'];

export type TaskKind = 'feature' | 'bug' | 'review';
export type TaskSize = 'S' | 'M' | 'L';

/**
 * How much of the team a task gets, picked by the manager at intake and only ever raised afterwards.
 * trivial: docs, comments, wording. The coder, then my push approval. No plan, review or tests.
 * small: a small, clear code change. The coder plans as it goes, then review and tests.
 * standard: the whole pipeline. Old tasks (no lane) are standard.
 */
export const LANES = ['trivial', 'small', 'standard'] as const;
export type Lane = (typeof LANES)[number];

/** The higher of two lanes: a task's lane only ever goes up. */
export function maxLane(a: Lane, b: Lane): Lane {
  return LANES.indexOf(a) >= LANES.indexOf(b) ? a : b;
}

export type GateKind = 'plan' | 'push' | 'command' | 'review_post' | 'question';
export type GateStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
export type GateDecision = 'approve' | 'reject' | 'allow_once' | 'allow_always' | 'deny';

/** Board columns, derived from status. */
export function boardColumn(status: TaskStatus): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'intake':
    case 'debugging':
    case 'researching':
    case 'planning':
      return 'Planning';
    case 'awaiting_answer':
    case 'awaiting_plan_approval':
    case 'awaiting_push_approval':
    case 'awaiting_review_post':
    case 'blocked':
    case 'paused':
    case 'stopped':
      return 'Awaiting you';
    case 'coding':
      return 'Building';
    case 'reviewing':
    case 'testing':
    case 'pushing':
    case 'reviewing_pr':
    case 'posting_review':
      return 'Review/Test';
    default:
      return 'Done';
  }
}
