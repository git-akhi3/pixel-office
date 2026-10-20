// Shared vocabulary for tasks, roles and gates.

export const ROLES = ['manager', 'architect', 'coder', 'ui-coder', 'all-rounder', 'reviewer', 'tester', 'debugger', 'researcher'] as const;
export type Role = (typeof ROLES)[number];

export const TASK_STATUSES = [
  'queued', // waiting for a slot to run intake
  'intake', // manager sizes and routes the task
  'debugging', // debugger finds the root cause (bugs flagged by intake)
  'researching', // researcher answers external questions (flagged by intake)
  'planning', // architect writes plan.md
  'awaiting_answer', // the architect's briefing question waited 15 minutes: parked until I answer
  'awaiting_plan_approval',
  'splitting', // epics: the architect splits the request into milestone tasks (breakdown.md)
  'awaiting_breakdown_approval',
  'coding',
  'reviewing',
  'testing',
  'awaiting_push_approval', // tasks from before PRs opened by themselves
  'pushing',
  'pr_open', // a draft PR from before the merge gate: the sweep notices when I merge it
  'awaiting_merge_approval', // the PR is open: approving merges it
  'merging',
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
  splitting: 'architect',
  coding: 'coder',
  reviewing: 'reviewer',
  testing: 'tester',
  retro: 'manager',
  reviewing_pr: 'reviewer',
};

export function isAgentStep(status: TaskStatus): boolean {
  return status in AGENT_STEPS;
}

/**
 * Who works a step on this task: the step's role, except for the coding step. A solo task is built by
 * the all-rounder; on the full team, a frontend task (the manager's call at intake: screens,
 * components, styling, layout) is built by the UI coder instead of the coder.
 */
export function stepRole(status: string, task: { frontend?: boolean | null; lane?: Lane | null }): Role | undefined {
  const role = AGENT_STEPS[status];
  if (role !== 'coder') return role;
  if (isSolo(task)) return 'all-rounder';
  return task.frontend ? 'ui-coder' : role;
}

export const TERMINAL_STATUSES: TaskStatus[] = ['done', 'failed', 'discarded'];

export type TaskKind = 'feature' | 'bug' | 'review';
export type TaskSize = 'S' | 'M' | 'L';

/**
 * How much of the team a task gets, picked at intake and only ever raised afterwards.
 * solo: the all-rounder does the whole job in one session (reads, changes, tests, reviews his own
 *   diff). A diff past the small-change limits gets one review on top.
 * standard: the full team: the architect's plan, the coder, the reviewer and the tester.
 * trivial and small: lanes from before solo existed, kept for old tasks; they now run as solo.
 * Old tasks with no lane are standard.
 */
export const LANES = ['trivial', 'small', 'solo', 'standard'] as const;
export type Lane = (typeof LANES)[number];

/** The higher of two lanes: a task's lane only ever goes up. */
export function maxLane(a: Lane, b: Lane): Lane {
  return LANES.indexOf(a) >= LANES.indexOf(b) ? a : b;
}

/** Built by the all-rounder alone, with no architect (solo, and the older trivial and small lanes). */
export function isSolo(task: { lane?: Lane | null }): boolean {
  return task.lane === 'solo' || task.lane === 'small' || task.lane === 'trivial';
}

/** How the office merges a repo's PRs once I approve (gh pr merge --squash, --merge or --rebase). */
export const MERGE_METHODS = ['squash', 'merge', 'rebase'] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

export type GateKind = 'plan' | 'push' | 'merge' | 'command' | 'review_post' | 'question' | 'breakdown';
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
    case 'splitting':
      return 'Planning';
    case 'awaiting_answer':
    case 'awaiting_plan_approval':
    case 'awaiting_breakdown_approval':
    case 'awaiting_push_approval':
    case 'awaiting_merge_approval':
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
    case 'merging':
    case 'reviewing_pr':
    case 'posting_review':
      return 'Review/Test';
    default:
      return 'Done';
  }
}
