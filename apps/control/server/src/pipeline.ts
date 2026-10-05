// The task state machine. Code decides what happens next; agents only do the work of each step.
//
//   queued → intake → [debugging] → [researching] → planning → awaiting_plan_approval
//     → coding → reviewing → testing → awaiting_push_approval → pushing → pr_open → retro → done
//
// Failures: review or test failures go back to the coder twice, then back to the architect.
// A coder blocker goes back to the architect. A task is re-planned at most twice, then it is blocked for me.

import { and, asc, eq, inArray } from 'drizzle-orm';
import type { AgentDef } from './agents.js';
import type { OfficeConfig } from './config.js';
import { getSettings, schema, type Db } from './db/index.js';
import type { Gate, Repo, Task } from './db/schema.js';
import { AGENT_STEPS, TERMINAL_STATUSES, isAgentStep, type GateDecision, type Role, type TaskKind, type TaskStatus } from './domain.js';
import type { EventBus } from './events.js';
import type { Publisher } from './github.js';
import { matchesAnyGlob, realPath } from './guard.js';
import { CONTRACTS, extractPr, normalizeOutput, readMeta, validateDoc, type ContractStep, type TaskDocs } from './handoffs.js';
import { buildPrompt } from './prompts.js';
import { addToAllowlist, effectiveAllowlist, getRepo } from './repos.js';
import type { AgentRunner, PermissionAnswer, RunOutcome } from './runner.js';
import { changedFiles, commitAll, createWorktree, diff, removeWorktree } from './worktree.js';

export const MAX_CODER_LOOPS = 2;
export const MAX_REPLANS = 2;
export const WORKTREE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RATE_LIMIT_FALLBACK_MS = 30 * 60 * 1000;

export interface PipelineDeps {
  db: Db;
  bus: EventBus;
  config: OfficeConfig;
  agents: Record<Role, AgentDef>;
  runner: AgentRunner;
  publisher: Publisher;
  docs: TaskDocs;
  now?: () => number;
}

export interface NewTask {
  repoId: number;
  input: string;
  kind?: TaskKind;
  title?: string;
}

export type TaskAction = 'stop' | 'resume' | 'discard' | 'done';

interface PendingPermission {
  taskId: number;
  unmatched: string[];
  resolve(answer: PermissionAnswer): void;
}

export class Pipeline {
  private running = new Map<number, AbortController>();
  private pending = new Map<number, PendingPermission>();
  private timers: NodeJS.Timeout[] = [];
  private ticking = false;
  private shuttingDown = false;
  private tickAgain = false;
  private inFlight = new Set<Promise<void>>();
  private now: () => number;

  constructor(private deps: PipelineDeps) {
    this.now = deps.now ?? Date.now;
  }

  // ------------------------------------------------------------ lifecycle

  start(): void {
    this.recover();
    this.timers.push(setInterval(() => void this.tick(), 15_000));
    this.timers.push(setInterval(() => void this.sweep(), 10 * 60_000));
    void this.tick();
    void this.sweep();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const t of this.timers) clearInterval(t);
    for (const abort of this.running.values()) abort.abort();
    await this.idle();
  }

  /** Resolves when no step is running (used by tests). */
  async idle(): Promise<void> {
    while (this.inFlight.size || this.ticking) {
      await Promise.all([...this.inFlight]);
      await new Promise((r) => setImmediate(r));
    }
  }

  isRunning(taskId: number): boolean {
    return this.running.has(taskId);
  }

  /** On boot, nothing is running: park interrupted steps instead of silently re-running them. */
  recover(): void {
    const { db } = this.deps;
    const active = db
      .select()
      .from(schema.tasks)
      .all()
      .filter((t) => (isAgentStep(t.status) && t.status !== 'queued') || t.status === 'pushing');
    for (const t of active) {
      this.update(t.id, { status: 'paused', resumeStatus: t.status, statusNote: 'The server restarted during this step. Resume to run it again.' });
      this.deps.bus.emit(t.id, 'paused', { reason: 'server restart', step: t.status });
    }
    db.update(schema.gates)
      .set({ status: 'cancelled', decidedAt: this.now() })
      .where(and(eq(schema.gates.kind, 'command'), eq(schema.gates.status, 'pending')))
      .run();
  }

  // ------------------------------------------------------------ tasks

  createTask(input: NewTask): Task {
    getRepo(this.deps.db, input.repoId);
    const text = input.input.trim();
    if (!text) throw new Error('Describe the task.');
    const title = (input.title?.trim() || text.split('\n')[0]!).slice(0, 80);
    const task = this.deps.db
      .insert(schema.tasks)
      .values({ repoId: input.repoId, input: text, title, kind: input.kind ?? 'feature' })
      .returning()
      .get();
    this.deps.bus.emit(task.id, 'created', { title });
    this.deps.bus.taskChanged(task);
    void this.tick();
    return task;
  }

  getTask(id: number): Task {
    const t = this.deps.db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
    if (!t) throw new Error(`No task ${id}`);
    return t;
  }

  private update(id: number, patch: Partial<Task>): Task {
    const task = this.deps.db
      .update(schema.tasks)
      .set({ ...patch, updatedAt: this.now() })
      .where(eq(schema.tasks.id, id))
      .returning()
      .get();
    this.deps.bus.taskChanged(task);
    return task;
  }

  private alert(task: Task, kind: string, message: string): void {
    this.deps.bus.emit(task.id, 'alert', { kind, message });
  }

  private block(task: Task, note: string, resumeStatus: TaskStatus | null = null): void {
    this.update(task.id, { status: 'blocked', statusNote: note, resumeStatus });
    this.alert(task, 'blocked', note);
  }

  // ------------------------------------------------------------ scheduling

  async tick(): Promise<void> {
    if (this.ticking) {
      this.tickAgain = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.tickAgain = false;
        this.schedule();
      } while (this.tickAgain);
    } finally {
      this.ticking = false;
    }
  }

  private schedule(): void {
    if (this.shuttingDown) return;
    const { db } = this.deps;
    const now = this.now();
    // Rate-limited tasks resume on their own once the limit resets.
    for (const t of db.select().from(schema.tasks).where(eq(schema.tasks.status, 'paused')).all()) {
      if (t.resumeAt && t.resumeAt <= now && t.resumeStatus) {
        this.update(t.id, { status: t.resumeStatus, resumeAt: null, resumeStatus: null, statusNote: null });
      }
    }
    const slots = getSettings(db).concurrency - this.running.size;
    if (slots <= 0) return;
    const runnable = db
      .select()
      .from(schema.tasks)
      .where(inArray(schema.tasks.status, Object.keys(AGENT_STEPS) as TaskStatus[]))
      .orderBy(asc(schema.tasks.updatedAt))
      .all()
      .filter((t) => !this.running.has(t.id))
      .slice(0, slots);
    for (const t of runnable) this.launch(t);
  }

  private launch(task: Task): void {
    const abort = new AbortController();
    this.running.set(task.id, abort);
    const p = this.execute(task, abort)
      .catch((e: unknown) => {
        const fresh = this.getTask(task.id);
        if (!TERMINAL_STATUSES.includes(fresh.status) && fresh.status !== 'stopped') {
          this.block(fresh, `Step failed: ${e instanceof Error ? e.message : String(e)}`, fresh.status);
        }
      })
      .finally(() => {
        this.running.delete(task.id);
        this.inFlight.delete(p);
        void this.tick();
      });
    this.inFlight.add(p);
  }

  // ------------------------------------------------------------ running a step

  private async execute(initial: Task, abort: AbortController): Promise<void> {
    const { db, bus, agents, docs, runner, config } = this.deps;
    let task = initial.status === 'queued' ? this.update(initial.id, { status: 'intake' }) : initial;
    const step = task.status as ContractStep;
    const role = AGENT_STEPS[step]!;
    const agent = agents[role];
    const repo = getRepo(db, task.repoId);

    // The retrospective only reads handoff documents; the worktree may already be gone after a merge.
    if (!task.worktreePath && step !== 'retro') {
      const wt = await createWorktree(repo, config.worktreesDir, task.id, task.title);
      task = this.update(task.id, { worktreePath: wt.path, branch: wt.branch, baseSha: wt.baseSha });
      bus.emit(task.id, 'worktree', { path: wt.path, branch: wt.branch });
    }
    const worktree = step === 'retro' ? realPath(docs.dir(task.id)) : task.worktreePath!;
    if (abort.signal.aborted) return; // stopped or discarded while the worktree was being made

    const feedback = task.feedback ?? undefined;
    if (feedback) task = this.update(task.id, { feedback: null });
    const prompt = buildPrompt(step, {
      task,
      repo,
      docs,
      worktree,
      feedback,
      diff: step === 'reviewing' && task.baseSha ? await diff(worktree, task.baseSha) : undefined,
    });

    const run = db
      .insert(schema.runs)
      .values({ taskId: task.id, role, step, model: agent.model, effort: agent.effort ?? null, status: 'running' })
      .returning()
      .get();
    bus.emit(task.id, 'step_start', { step, role, model: agent.model, effort: agent.effort }, run.id);

    const outcome = await runner.run({
      taskId: task.id,
      runId: run.id,
      role,
      agent,
      prompt,
      cwd: worktree,
      guard: { worktree, write: agent.write, testGlobs: repo.testGlobs, allowlist: effectiveAllowlist(repo) },
      signal: abort.signal,
      onEvent: (type, payload) => bus.emit(task.id, type, payload, run.id),
      askPermission: (subject, unmatched) => this.requestPermission(task.id, subject, unmatched),
      validate: (text) => validateDoc(step, text),
    });
    this.recordRun(run.id, outcome);
    bus.emit(task.id, 'step_end', { step, role, status: outcome.status, error: outcome.error, usage: outcome.usage }, run.id);

    task = this.getTask(task.id);
    if (task.status !== step) return; // stopped or discarded while running

    if (step === 'retro' && outcome.status !== 'ok' && outcome.status !== 'interrupted') {
      // A missing retrospective must not keep a finished task open.
      this.update(task.id, { status: 'done', doneAt: this.now(), statusNote: `No retrospective: ${outcome.error ?? outcome.status}` });
      return;
    }

    switch (outcome.status) {
      case 'interrupted':
        this.update(task.id, { status: 'stopped', resumeStatus: step });
        return;
      case 'rate_limited': {
        const resumeAt = outcome.resetsAt ? outcome.resetsAt * 1000 : this.now() + RATE_LIMIT_FALLBACK_MS;
        this.update(task.id, {
          status: 'paused',
          resumeStatus: step,
          resumeAt,
          statusNote: `Usage limit reached. Resumes at ${new Date(resumeAt).toLocaleTimeString()}.`,
        });
        this.alert(task, 'rate_limit', `Paused until ${new Date(resumeAt).toLocaleString()}`);
        return;
      }
      case 'failed':
        this.block(task, `${role} failed: ${outcome.error ?? 'unknown error'}`, step);
        return;
      case 'ok': {
        const text = normalizeOutput(outcome.text);
        docs.save(task.id, CONTRACTS[step].doc, text);
        await this.afterStep(task, step, text);
        this.checkTokenBudget(this.getTask(task.id));
      }
    }
  }

  private recordRun(runId: number, o: RunOutcome): void {
    this.deps.db
      .update(schema.runs)
      .set({
        status: o.status,
        error: o.error ?? null,
        sessionId: o.sessionId ?? null,
        inputTokens: o.usage.input,
        outputTokens: o.usage.output,
        cacheReadTokens: o.usage.cacheRead,
        cacheWriteTokens: o.usage.cacheWrite,
        thinkingTokens: o.usage.thinking,
        durationMs: o.durationMs,
        endedAt: this.now(),
      })
      .where(eq(schema.runs.id, runId))
      .run();
  }

  private async afterStep(task: Task, step: ContractStep, text: string): Promise<void> {
    const { docs } = this.deps;
    switch (step) {
      case 'intake': {
        const m = readMeta<{ title: string; kind: TaskKind; size: 'S' | 'M' | 'L'; needs_debugger: boolean; needs_researcher: boolean; design_review: boolean }>('intake', text);
        const updated = this.update(task.id, {
          title: m.title,
          kind: m.kind,
          size: m.size,
          needsDebugger: m.needs_debugger,
          needsResearcher: m.needs_researcher,
          designFlag: m.design_review,
        });
        this.update(task.id, { status: updated.needsDebugger ? 'debugging' : updated.needsResearcher ? 'researching' : 'planning' });
        return;
      }
      case 'debugging':
        this.update(task.id, { status: task.needsResearcher ? 'researching' : 'planning' });
        return;
      case 'researching':
        this.update(task.id, { status: 'planning' });
        return;
      case 'planning': {
        const m = readMeta<{ files_in_scope: string[]; token_estimate: number }>('planning', text);
        this.update(task.id, { filesInScope: m.files_in_scope, tokenEstimate: m.token_estimate, status: 'awaiting_plan_approval' });
        this.openGate(task.id, 'plan');
        return;
      }
      case 'coding': {
        const m = readMeta<{ status: 'done' | 'blocked' }>('coding', text);
        if (m.status === 'blocked') {
          docs.save(task.id, 'blocked', text);
          this.alert(task, 'blocked', 'The coder raised a blocker: the plan goes back to the architect.');
          this.replan(task, `The coder could not follow the plan and raised this blocker:\n\n${text}`);
          return;
        }
        const pr = extractPr(text);
        if (pr) docs.save(task.id, 'pr', `# ${pr.title}\n\n${pr.body}`);
        const repo = getRepo(this.deps.db, task.repoId);
        await commitAll(task.worktreePath!, pr?.title ?? task.title, repo.gitAuthor);
        await this.checkScope(task);
        this.update(task.id, { status: 'reviewing' });
        return;
      }
      case 'reviewing': {
        const m = readMeta<{ verdict: 'pass' | 'fail'; blocking: number }>('reviewing', text);
        if (m.verdict === 'fail' || m.blocking > 0) {
          this.failure(task, `The review found ${m.blocking} blocking issue(s). Fix exactly those:\n\n${text}`);
          return;
        }
        this.update(task.id, { status: 'testing' });
        return;
      }
      case 'testing': {
        const m = readMeta<{ result: 'pass' | 'fail'; tests_added: number }>('testing', text);
        const repo = getRepo(this.deps.db, task.repoId);
        await commitAll(task.worktreePath!, `test: ${task.title}`, repo.gitAuthor);
        if (m.result === 'fail') {
          const failures = task.testFailures + 1;
          task = this.update(task.id, { testFailures: failures });
          if (failures >= 3) this.alert(task, 'tests_failing', `Tests have failed ${failures} times on this task.`);
          this.failure(task, `The tests fail. Make them pass without weakening them:\n\n${text}`);
          return;
        }
        await this.openPushGate(task);
        return;
      }
      case 'retro':
        this.update(task.id, { status: 'done', doneAt: this.now(), statusNote: null });
        return;
    }
  }

  /** Review or tests failed: back to the coder twice, then re-plan. */
  private failure(task: Task, feedback: string): void {
    const loops = task.loopCount + 1;
    if (loops <= MAX_CODER_LOOPS) {
      this.update(task.id, { loopCount: loops, feedback, status: 'coding' });
      return;
    }
    this.alert(task, 'loops_exhausted', `Still failing after ${MAX_CODER_LOOPS} fixes: back to the architect.`);
    this.replan(task, `The coder could not get review and tests to pass after ${MAX_CODER_LOOPS} attempts. Revise the plan.\n\nLatest report:\n\n${feedback}`);
  }

  private replan(task: Task, feedback: string): void {
    if (task.replanCount >= MAX_REPLANS) {
      this.block(task, `Re-planned ${MAX_REPLANS} times and still stuck. Over to you.`, 'planning');
      this.update(task.id, { feedback });
      return;
    }
    const previous = this.deps.docs.latest(task.id, 'plan');
    this.update(task.id, {
      replanCount: task.replanCount + 1,
      loopCount: 0,
      feedback: previous ? `${feedback}\n\n### Previous plan (revise it)\n${previous}` : feedback,
      status: 'planning',
    });
  }

  private async checkScope(task: Task): Promise<void> {
    if (!task.baseSha || !task.filesInScope.length) return;
    const files = await changedFiles(task.worktreePath!, task.baseSha);
    const outside = files.filter((f) => !task.filesInScope.some((s) => s === f || matchesAnyGlob(f, [s])));
    if (outside.length) {
      this.alert(task, 'scope', `The coder changed files outside the plan: ${outside.slice(0, 10).join(', ')}${outside.length > 10 ? '…' : ''}`);
    }
  }

  tokensUsed(taskId: number, steps?: TaskStatus[]): number {
    const runs = this.deps.db.select().from(schema.runs).where(eq(schema.runs.taskId, taskId)).all();
    return runs
      .filter((r) => !steps || steps.includes(r.step))
      .reduce((sum, r) => sum + r.inputTokens + r.outputTokens + r.cacheWriteTokens, 0);
  }

  private checkTokenBudget(task: Task): void {
    if (!task.tokenEstimate) return;
    const used = this.tokensUsed(task.id, ['coding', 'reviewing', 'testing']);
    if (used <= task.tokenEstimate * 2) return;
    const already = this.deps.db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.taskId, task.id), eq(schema.events.type, 'alert')))
      .all()
      .some((e) => e.payload.kind === 'tokens');
    if (!already) this.alert(task, 'tokens', `Used ${used.toLocaleString()} tokens, over 2× the plan's estimate of ${task.tokenEstimate.toLocaleString()}.`);
  }

  // ------------------------------------------------------------ gates

  private openGate(taskId: number, kind: Gate['kind'], subject: string | null = null, auto = false): Gate {
    const gate = this.deps.db
      .insert(schema.gates)
      .values({ taskId, kind, subject, auto, ...(auto ? { status: 'approved' as const, decision: 'approve', decidedAt: this.now() } : {}) })
      .returning()
      .get();
    this.deps.bus.emit(taskId, 'gate', { gateId: gate.id, kind, subject, status: gate.status, auto });
    return gate;
  }

  private async openPushGate(task: Task): Promise<void> {
    const auto = getSettings(this.deps.db).autoApprovePush;
    if (auto) {
      // Only reached when review and tests both passed; the publisher still enforces branch rules.
      this.openGate(task.id, 'push', null, true);
      await this.push(task);
      return;
    }
    this.update(task.id, { status: 'awaiting_push_approval' });
    this.openGate(task.id, 'push');
  }

  private requestPermission(taskId: number, subject: string, unmatched: string[]): Promise<PermissionAnswer> {
    const gate = this.openGate(taskId, 'command', subject);
    const task = this.update(taskId, { statusNote: 'Waiting for you to allow a command.' });
    this.alert(task, 'permission', `Allow command? ${subject}`);
    return new Promise((resolve) => {
      this.pending.set(gate.id, { taskId, unmatched, resolve });
    });
  }

  pendingGates(taskId?: number): Gate[] {
    const all = this.deps.db.select().from(schema.gates).where(eq(schema.gates.status, 'pending')).all();
    return taskId === undefined ? all : all.filter((g) => g.taskId === taskId);
  }

  async decideGate(gateId: number, decision: GateDecision, comment?: string): Promise<void> {
    const { db } = this.deps;
    const gate = db.select().from(schema.gates).where(eq(schema.gates.id, gateId)).get();
    if (!gate) throw new Error(`No gate ${gateId}`);
    if (gate.status !== 'pending') throw new Error('This gate has already been decided.');
    let task = this.getTask(gate.taskId);

    const close = (status: Gate['status']) =>
      db.update(schema.gates).set({ status, decision, comment: comment ?? null, decidedAt: this.now() }).where(eq(schema.gates.id, gateId)).run();

    if (gate.kind === 'command') {
      if (!['allow_once', 'allow_always', 'deny'].includes(decision)) throw new Error('Use allow_once, allow_always or deny.');
      const p = this.pending.get(gateId);
      close(decision === 'deny' ? 'rejected' : 'approved');
      if (decision === 'allow_always' && p) {
        let repo: Repo = getRepo(db, task.repoId);
        for (const cmd of p.unmatched) repo = addToAllowlist(db, repo, cmd);
      }
      this.pending.delete(gateId);
      this.update(task.id, { statusNote: null });
      this.deps.bus.emit(task.id, 'gate_decided', { gateId, kind: gate.kind, decision });
      p?.resolve(decision as PermissionAnswer);
      return;
    }

    if (!['approve', 'reject'].includes(decision)) throw new Error('Use approve or reject.');
    if (decision === 'reject' && !comment?.trim()) throw new Error('Say what to change when rejecting.');
    const expected = gate.kind === 'plan' ? 'awaiting_plan_approval' : 'awaiting_push_approval';
    if (task.status !== expected) throw new Error(`The task is ${task.status}, not ${expected}.`);
    close(decision === 'approve' ? 'approved' : 'rejected');
    this.deps.bus.emit(task.id, 'gate_decided', { gateId, kind: gate.kind, decision, comment });

    if (gate.kind === 'plan') {
      task = this.update(task.id, decision === 'approve' ? { status: 'coding' } : { status: 'planning', feedback: `The owner rejected the plan:\n\n${comment}\n\n### Rejected plan\n${this.deps.docs.latest(task.id, 'plan') ?? ''}` });
    } else if (decision === 'approve') {
      await this.push(task);
    } else {
      this.update(task.id, { status: 'coding', feedback: `The owner did not approve the push:\n\n${comment}` });
    }
    void this.tick();
  }

  private async push(task: Task): Promise<void> {
    task = this.update(task.id, { status: 'pushing', statusNote: null });
    try {
      const repo = getRepo(this.deps.db, task.repoId);
      const prDoc = this.deps.docs.latest(task.id, 'pr');
      const title = prDoc?.match(/^# (.+)$/m)?.[1] ?? task.title;
      const body = `${prDoc?.replace(/^# .+\n+/, '') ?? ''}\n\n---\nOpened by Pixel Office (task #${task.id}).`.trim();
      const url = await this.deps.publisher.pushAndOpenDraftPr(repo, task.worktreePath!, task.branch!, { title, body });
      this.update(task.id, { status: 'pr_open', prUrl: url });
      this.deps.bus.emit(task.id, 'pr_opened', { url });
    } catch (e) {
      this.block(task, `Push failed: ${e instanceof Error ? e.message : String(e)}`, 'pushing');
    }
  }

  // ------------------------------------------------------------ actions

  async action(taskId: number, action: TaskAction): Promise<Task> {
    const task = this.getTask(taskId);
    switch (action) {
      case 'stop': {
        if (TERMINAL_STATUSES.includes(task.status) || task.status === 'stopped') throw new Error(`The task is ${task.status}.`);
        this.cancelPermissions(taskId);
        const resumeStatus = task.status === 'paused' || task.status === 'blocked' ? task.resumeStatus : task.status;
        const stopped = this.update(taskId, { status: 'stopped', resumeStatus, resumeAt: null });
        this.running.get(taskId)?.abort();
        this.deps.bus.emit(taskId, 'stopped', {});
        return stopped;
      }
      case 'resume': {
        if (!['stopped', 'paused', 'blocked'].includes(task.status)) throw new Error(`The task is ${task.status}; nothing to resume.`);
        const target = task.resumeStatus ?? 'queued';
        this.deps.bus.emit(taskId, 'resumed', { status: target });
        if (target === 'pushing') {
          await this.push(task);
          return this.getTask(taskId);
        }
        const resumed = this.update(taskId, { status: target, resumeStatus: null, resumeAt: null, statusNote: null });
        void this.tick();
        return resumed;
      }
      case 'discard': {
        if (task.status === 'discarded') return task;
        this.cancelGates(taskId);
        const discarded = this.update(taskId, { status: 'discarded', statusNote: null });
        this.running.get(taskId)?.abort();
        if (task.worktreePath) {
          await removeWorktree(getRepo(this.deps.db, task.repoId), task.worktreePath).catch(() => {});
          this.update(taskId, { worktreePath: null });
        }
        this.deps.bus.emit(taskId, 'discarded', {});
        return discarded;
      }
      case 'done': {
        if (!['pr_open', 'blocked', 'stopped', 'awaiting_push_approval'].includes(task.status)) {
          throw new Error(`The task is ${task.status}; it cannot be marked done.`);
        }
        this.cancelGates(taskId);
        const done = this.update(taskId, { status: 'retro', statusNote: null, resumeStatus: null });
        void this.tick();
        return done;
      }
    }
  }

  /** A finished or discarded task leaves no gate waiting for me. */
  private cancelGates(taskId: number): void {
    this.cancelPermissions(taskId);
    this.deps.db
      .update(schema.gates)
      .set({ status: 'cancelled', decidedAt: this.now() })
      .where(and(eq(schema.gates.taskId, taskId), eq(schema.gates.status, 'pending')))
      .run();
  }

  private cancelPermissions(taskId: number): void {
    for (const [gateId, p] of this.pending) {
      if (p.taskId !== taskId) continue;
      this.deps.db.update(schema.gates).set({ status: 'cancelled', decidedAt: this.now() }).where(eq(schema.gates.id, gateId)).run();
      this.pending.delete(gateId);
      p.resolve('deny');
    }
  }

  // ------------------------------------------------------------ housekeeping

  /** Detects merged PRs and removes old worktrees. */
  async sweep(): Promise<void> {
    const { db, publisher } = this.deps;
    for (const t of db.select().from(schema.tasks).where(eq(schema.tasks.status, 'pr_open')).all()) {
      if (!t.prUrl) continue;
      const state = await publisher.prState(getRepo(db, t.repoId), t.prUrl).catch(() => 'UNKNOWN' as const);
      if (state === 'MERGED') {
        this.deps.bus.emit(t.id, 'pr_merged', { url: t.prUrl });
        this.update(t.id, { status: 'retro' });
        await this.dropWorktree(t);
      } else if (state === 'CLOSED') {
        this.update(t.id, { statusNote: 'The PR was closed without merging.' });
      }
    }
    const cutoff = this.now() - WORKTREE_RETENTION_MS;
    for (const t of db.select().from(schema.tasks).where(eq(schema.tasks.status, 'done')).all()) {
      if (t.worktreePath && t.doneAt && t.doneAt < cutoff) await this.dropWorktree(t);
    }
    void this.tick();
  }

  private async dropWorktree(t: Task): Promise<void> {
    if (!t.worktreePath) return;
    await removeWorktree(getRepo(this.deps.db, t.repoId), t.worktreePath).catch(() => {});
    this.update(t.id, { worktreePath: null });
  }
}
