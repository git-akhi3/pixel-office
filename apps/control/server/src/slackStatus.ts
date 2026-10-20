// The longer answers to "status" in Slack: one task in detail, or every active task in a list.
// Pure functions of the task rows, so they can be tested without Slack.

import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { schema } from './db/index.js';
import type { Gate, Task } from './db/schema.js';
import { boardColumn, isAgentStep, isSolo, stepRole, TERMINAL_STATUSES, type TaskStatus } from './domain.js';
import { estimateRemaining, formatEta } from './eta.js';
import { heroForRole } from './heroes.js';

/** The order a feature or bug task moves through. Waiting states sit where the work resumes. */
const FEATURE_STAGES: TaskStatus[] = ['queued', 'intake', 'planning', 'awaiting_plan_approval', 'coding', 'reviewing', 'testing', 'pushing', 'awaiting_merge_approval', 'merging', 'retro', 'done'];
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

export function clip(text: string, max: number): string {
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

/** Steps a solo task skips (see lanes.ts): it has no plan and no tester, and a review only when the diff is big. */
const SOLO_SKIPS: TaskStatus[] = ['planning', 'awaiting_plan_approval', 'testing'];

/** "stage 5 of 12": rough position in the pipeline. The time left comes from eta.ts, not from this. */
export function stageOf(task: Task): { n: number; of: number } | null {
  const skipped = isSolo(task) ? SOLO_SKIPS : [];
  const stages = task.kind === 'review' ? REVIEW_STAGES : FEATURE_STAGES.filter((s) => !skipped.includes(s));
  // A paused, blocked or stopped task sits where it will resume. Debugging and research happen before planning.
  let at: TaskStatus = ['paused', 'blocked', 'stopped'].includes(task.status) ? (task.resumeStatus ?? task.status) : task.status;
  if (at === 'debugging' || at === 'researching') at = 'planning';
  const i = stages.indexOf(at);
  return i < 0 ? null : { n: i + 1, of: stages.length };
}

/** The gate to decide, for Fury's approve and reject tools: " (gate 14)". */
function gateRef(gates: Gate[]): string {
  const gate = gates.find((g) => g.kind !== 'command' && g.kind !== 'question');
  return gate ? ` (gate ${gate.id})` : '';
}

/** What is waiting on the owner, in words, or null when the office is working on its own. */
export function waitingOnYou(task: Task, gates: Gate[]): string | null {
  const command = gates.find((g) => g.kind === 'command');
  if (command) return `allow or deny a command: \`${esc(clip((command.subject ?? '').replace(/`/g, "'"), 160))}\``;
  switch (task.status) {
    case 'awaiting_plan_approval':
      return `approve or reject the plan${gateRef(gates)}`;
    case 'awaiting_breakdown_approval':
      return `approve or reject the milestone split${gateRef(gates)}`;
    case 'awaiting_push_approval':
      return `approve or reject the push (opens the PR)${gateRef(gates)}`;
    case 'awaiting_merge_approval':
      return `merge the PR, or send it back with what to change${gateRef(gates)}`;
    case 'awaiting_deploy_approval':
      return `deploy it to staging, or not now${gateRef(gates)}`;
    case 'check_failed':
      return `roll staging back, or keep it (a fix task is on it)${gateRef(gates)}`;
    case 'awaiting_review_post':
      return `edit and post the draft review${gateRef(gates)}`;
    case 'blocked':
      return 'unblock it: read the note, then give it a new instruction, ask for a new plan, or resume it';
    case 'paused':
      return 'nothing, unless it stays paused: resume it';
    case 'stopped':
      return 'resume it to continue, or discard it';
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

/** When the task's current run began, from the runs table (it survives a restart, unlike the bridge's own clock). */
function runningSince(ctx: StatusContext, task: Task): number | undefined {
  return ctx.db
    .select({ startedAt: schema.runs.startedAt })
    .from(schema.runs)
    .where(and(eq(schema.runs.taskId, task.id), eq(schema.runs.status, 'running')))
    .orderBy(desc(schema.runs.id))
    .limit(1)
    .get()?.startedAt;
}

function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

/** What happened last, in a few words each, newest first: what a hero is up to, or what changed. */
export function recentEvents(db: Db, taskId: number, now: number, max = 5): string[] {
  const rows = db.select().from(schema.events).where(eq(schema.events.taskId, taskId)).orderBy(desc(schema.events.id)).limit(60).all();
  const out: string[] = [];
  for (const e of rows) {
    const p = e.payload;
    const who = (role: unknown) => heroForRole(String(role ?? ''))?.name ?? String(role ?? 'an agent');
    let line: string | null = null;
    switch (e.type) {
      case 'step_start':
        line = `${who(p.role)} started ${String(p.step ?? '').replace(/_/g, ' ')}`;
        break;
      case 'step_end':
        line = `${who(p.role)} ${p.status === 'ok' ? 'finished' : `stopped (${String(p.status)})`} ${String(p.step ?? '').replace(/_/g, ' ')}`;
        break;
      case 'text':
        line = `said "${esc(clip(String(p.text ?? '').replace(/\s+/g, ' '), 90))}"`;
        break;
      case 'gate':
        line = p.status === 'pending' ? `asked for your OK (${String(p.kind)})` : null;
        break;
      case 'gate_decided':
        line = `${String(p.decision)} (${String(p.kind)})`;
        break;
      case 'alert':
        line = `alert: ${esc(clip(String(p.message ?? ''), 80))}`;
        break;
      case 'pr_opened':
      case 'pr_updated':
      case 'pr_merged':
        line = e.type.replace('_', ' ');
        break;
      case 'steered':
        line = `you steered it: "${esc(clip(String(p.text ?? ''), 60))}"`;
        break;
      case 'stopped':
      case 'resumed':
        line = e.type;
        break;
    }
    if (line) out.push(`${line} (${ago(now - e.at)})`);
    if (out.length >= max) break;
  }
  return out;
}

/** One task in detail. */
export function describeTask(task: Task, ctx: StatusContext): string {
  const stage = stageOf(task);
  const gates = ctx.pendingGates(task.id);
  const running = isAgentStep(task.status);
  const head = [`*#${task.id}* ${esc(task.title)}`, `${esc(task.status.replace(/_/g, ' '))} (${boardColumn(task.status)})`];
  if (stage) head.push(`stage ${stage.n} of ${stage.of}`);
  if (task.lane && task.lane !== 'standard') head.push(`${task.lane} lane`);
  const lines = [head.join(' · ')];

  const work: string[] = [];
  const stepStart = runningSince(ctx, task) ?? ctx.stepStartedAt(task.id) ?? task.updatedAt;
  if (running) {
    const role = stepRole(task.status, task)!;
    const hero = heroForRole(role);
    work.push(`${hero ? `${hero.name} (${role})` : role} working`);
    work.push(`${duration(ctx.now - stepStart)} in this step`);
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
  if (task.parentId) lines.push(`• Milestone of #${task.parentId}${task.dependsOn ? `, after #${task.dependsOn}` : ''}`);
  const question = ctx.db
    .select()
    .from(schema.questions)
    .where(and(eq(schema.questions.taskId, task.id), isNull(schema.questions.answer), eq(schema.questions.delegated, false)))
    .orderBy(asc(schema.questions.id))
    .limit(1)
    .get();
  if (question && gates.some((g) => g.kind === 'question')) lines.push(`• Open question from the architect (id ${question.id}): ${esc(clip(question.title, 160))}`);
  const eta = estimateRemaining(ctx.db, task, running ? ctx.now - stepStart : 0);
  if (eta) lines.push(`• ${formatEta(eta)}`);
  const recent = recentEvents(ctx.db, task.id, ctx.now);
  if (recent.length) lines.push(`• Lately: ${recent.join(' · ')}`);
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
  lines.push('Ask about one task for its full detail.');
  return lines.join('\n');
}
