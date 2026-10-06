// The longer answers to "status" in Slack: one task in detail, or every active task in a list.
// Pure functions of the task rows, so they can be tested without Slack.

import { desc, eq, and } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { schema } from './db/index.js';
import type { Gate, Task } from './db/schema.js';
import { AGENT_STEPS, boardColumn, isAgentStep, TERMINAL_STATUSES, type TaskStatus } from './domain.js';

/** The order a feature or bug task moves through. Waiting states sit where the work resumes. */
const FEATURE_STAGES: TaskStatus[] = ['queued', 'intake', 'planning', 'awaiting_plan_approval', 'coding', 'reviewing', 'testing', 'awaiting_push_approval', 'pushing', 'pr_open', 'retro', 'done'];
const REVIEW_STAGES: TaskStatus[] = ['queued', 'reviewing_pr', 'awaiting_review_post', 'posting_review', 'done'];

/** Statuses whose tokens count against the architect's estimate (the same steps the budget alert watches). */
const BUILD_STEPS: TaskStatus[] = ['coding', 'reviewing', 'testing'];

export interface StatusContext {
  db: Db;
  now: number;
  publicUrl: string;
  /** Total tokens, and tokens in the build steps, for a task. */
  tokensUsed: (taskId: number, steps?: TaskStatus[]) => number;
  pendingGates: (taskId: number) => Gate[];
  /** When the current agent step started, if known. */
  stepStartedAt: (taskId: number) => number | undefined;
}

export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n);
}

/** "stage 5 of 12": rough position in the pipeline. Not a time estimate. */
export function stageOf(task: Task): { n: number; of: number } | null {
  const stages = task.kind === 'review' ? REVIEW_STAGES : FEATURE_STAGES;
  // A paused, blocked or stopped task sits where it will resume. Debugging and research happen before planning.
  let at: TaskStatus = ['paused', 'blocked', 'stopped'].includes(task.status) ? (task.resumeStatus ?? task.status) : task.status;
  if (at === 'debugging' || at === 'researching') at = 'planning';
  const i = stages.indexOf(at);
  return i < 0 ? null : { n: i + 1, of: stages.length };
}

/** What is waiting on the owner, in words, or null when the office is working on its own. */
export function waitingOnYou(task: Task, gates: Gate[]): string | null {
  const command = gates.find((g) => g.kind === 'command');
  if (command) return `allow or deny a command: \`${esc(clip((command.subject ?? '').replace(/`/g, "'"), 160))}\``;
  switch (task.status) {
    case 'awaiting_plan_approval':
      return 'approve or reject the plan';
    case 'awaiting_push_approval':
      return 'approve or reject the push (opens a draft PR)';
    case 'awaiting_review_post':
      return 'edit and post the draft review';
    case 'blocked':
      return 'unblock it: read the note, then `steer:`, `replan:` or `resume`';
    case 'paused':
      return 'nothing, unless it stays paused: say `resume`';
    case 'stopped':
      return 'say `resume` to continue, or `discard`';
    default:
      return null;
  }
}

function latestAlert(db: Db, taskId: number): string | null {
  const e = db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.taskId, taskId), eq(schema.events.type, 'alert')))
    .orderBy(desc(schema.events.id))
    .limit(1)
    .get();
  return e ? String(e.payload.message ?? '') || null : null;
}

/** One task in detail. */
export function describeTask(task: Task, ctx: StatusContext): string {
  const stage = stageOf(task);
  const gates = ctx.pendingGates(task.id);
  const running = isAgentStep(task.status);
  const head = [`*#${task.id}* ${esc(task.title)}`, `${esc(task.status.replace(/_/g, ' '))} (${boardColumn(task.status)})`];
  if (stage) head.push(`stage ${stage.n} of ${stage.of}`);
  const lines = [head.join(' · ')];

  const work: string[] = [];
  if (running) {
    work.push(`${AGENT_STEPS[task.status]} working`);
    work.push(`${duration(ctx.now - (ctx.stepStartedAt(task.id) ?? task.updatedAt))} in this step`);
  }
  work.push(`${duration(ctx.now - task.createdAt)} since it started`);
  lines.push(`• ${work.join(' · ')}`);

  const total = ctx.tokensUsed(task.id);
  let spend = `${tokens(total)} tokens used`;
  if (task.tokenEstimate) {
    const build = ctx.tokensUsed(task.id, BUILD_STEPS);
    spend += `; build steps at ${tokens(build)} of the plan's ~${tokens(task.tokenEstimate)} estimate (${Math.round((build / task.tokenEstimate) * 100)}%)`;
  }
  lines.push(`• ${spend}`);

  const waiting = waitingOnYou(task, gates);
  lines.push(waiting ? `• *Waiting on you:* ${waiting}` : '• Nothing waiting on you');
  if (task.statusNote) lines.push(`• Note: ${esc(clip(task.statusNote, 300))}`);
  const alert = ['blocked', 'paused', 'stopped'].includes(task.status) ? latestAlert(ctx.db, task.id) : null;
  if (alert && alert !== task.statusNote) lines.push(`• Last alert: ${esc(clip(alert, 300))}`);
  if (task.prUrl) lines.push(`• PR: ${task.prUrl}`);
  lines.push('• No time estimate: the office doesn\'t predict one. The stage count is a rough guide only.');
  lines.push(`<${ctx.publicUrl}/#/task/${task.id}|Open in office>`);
  return lines.join('\n');
}

function threadLink(task: Task): string {
  if (!task.slackChannel || !task.slackThreadTs) return '';
  return ` · <https://slack.com/archives/${task.slackChannel}/p${task.slackThreadTs.replace('.', '')}|thread>`;
}

/** Every task that isn't finished, one line each. */
export function listActive(ctx: StatusContext): string {
  const active = ctx.db
    .select()
    .from(schema.tasks)
    .all()
    .filter((t) => !TERMINAL_STATUSES.includes(t.status))
    .sort((a, b) => a.id - b.id);
  if (active.length === 0) return 'No active tasks.';
  const waiting = active.filter((t) => waitingOnYou(t, ctx.pendingGates(t.id)) && !['paused'].includes(t.status)).length;
  const lines = [`*${active.length} active task${active.length === 1 ? '' : 's'}*${waiting ? `, ${waiting} waiting on you` : ''}`];
  for (const t of active) {
    const stage = stageOf(t);
    const w = waitingOnYou(t, ctx.pendingGates(t.id));
    const parts = [`*#${t.id}* ${esc(clip(t.title, 60))}`, esc(t.status.replace(/_/g, ' '))];
    if (stage) parts.push(`stage ${stage.n}/${stage.of}`);
    parts.push(`${tokens(ctx.tokensUsed(t.id))} tokens`);
    if (w) parts.push(`:raised_hand: ${w}`);
    lines.push(`• ${parts.join(' · ')}${threadLink(t)}`);
  }
  lines.push('Say `status` inside a task\'s thread for its full detail.');
  return lines.join('\n');
}
