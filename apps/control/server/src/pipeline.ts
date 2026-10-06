// The task state machine. Code decides what happens next; agents only do the work of each step.
//
//   queued → intake → [debugging] → [researching] → planning → awaiting_plan_approval
//     → coding → reviewing → testing → awaiting_push_approval → pushing → pr_open → retro → done
//
// Failures: review or test failures go back to the coder twice, then back to the architect.
// A coder blocker goes back to the architect. A task is re-planned at most twice, then it is blocked for me.

import { and, asc, eq, inArray } from 'drizzle-orm';
import { isWrapperSkill, listSkills, withRepoSkills, withSkills, type AgentDef } from './agents.js';
import type { Graphs } from './graph.js';
import { proposalFromRetro, type Knowledge } from './knowledge.js';
import type { OfficeConfig } from './config.js';
import { getSettings, schema, usagePause, type Db } from './db/index.js';
import type { Gate, GrillMode, Question, Repo, SkillPicks, Task } from './db/schema.js';
import { attachmentsDir, cleanLinks, Uploads } from './attachments.js';
import { answersMessage, BRIEFING_WAIT_MS, briefDoc, MAX_BAD_ROUNDS, parseRound, type Delivery, type RoundQuestion } from './briefing.js';
import { AGENT_STEPS, TERMINAL_STATUSES, isAgentStep, type GateDecision, type Role, type TaskKind, type TaskStatus } from './domain.js';
import type { EventBus } from './events.js';
import type { PrInfo, Publisher } from './github.js';
import { matchesAnyGlob, realPath } from './guard.js';
import { CONTRACTS, extractPr, normalizeOutput, readMeta, validateDoc, type ContractStep, type TaskDocs } from './handoffs.js';
import { buildPrompt, PICKABLE_ROLES } from './prompts.js';
import { addToAllowlist, effectiveAllowlist, getRepo } from './repos.js';
import type { AgentRunner, PermissionAnswer, RunOutcome } from './runner.js';
import { commentableLines, formatComment, originSlug, parsePrUrl, parseReviewDoc, prSlug, reviewBody, splitComments } from './reviews.js';
import { changedFiles, commitAll, createReviewWorktree, createWorktree, diff, removeWorktree } from './worktree.js';

/** One spelling per PR, so manual and auto-picked reviews of the same PR match. */
const canonicalPrUrl = (slug: string, number: number) => `https://github.com/${slug.toLowerCase()}/pull/${number}`;
/** Hidden in posted review bodies so a resumed post can tell whether GitHub already has it. */
const reviewMarker = (taskId: number) => `<!-- pixel-office review task #${taskId} -->`;
/** Auto-pickup retries a skipped or failed PR after this long (it may have grown or the error passed). */
const PICKUP_RETRY_MS = 60 * 60 * 1000;

export const MAX_CODER_LOOPS = 2;
/** Skills the manager may pick per role; most tasks need none or one. */
const MAX_MANAGER_PICKS = 4;
export const MAX_REPLANS = 2;
export const WORKTREE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RATE_LIMIT_FALLBACK_MS = 30 * 60 * 1000;

export interface PipelineDeps {
  db: Db;
  bus: EventBus;
  config: OfficeConfig;
  agents: Record<Role, AgentDef>;
  knowledge: Knowledge;
  graphs: Graphs;
  runner: AgentRunner;
  publisher: Publisher;
  docs: TaskDocs;
  now?: () => number;
  /** owner/name of a repo on GitHub (from its origin remote). Injectable for tests. */
  slugOf?: (repo: Repo) => Promise<string | null>;
  /** How long a planning session waits for a question round's answers before parking. */
  briefingWaitMs?: number;
  /** Files uploaded for missions, claimed when a task is created. */
  uploads?: Uploads;
}

export interface NewTask {
  repoId: number;
  input: string;
  kind?: TaskKind;
  title?: string;
  /** Start from and target this branch instead of the default branch. */
  baseBranch?: string;
  /** My skill picks per role; these roles are locked for the manager. */
  skills?: Partial<Record<Role, string[]>>;
  grillMode?: GrillMode;
  /** Upload ids (from POST /api/uploads) and links I attached. */
  attachments?: string[];
  links?: string[];
}

export type TaskAction = 'stop' | 'resume' | 'discard' | 'done';

interface PendingPermission {
  taskId: number;
  unmatched: string[];
  resolve(answer: PermissionAnswer): void;
}

export class Pipeline {
  private running = new Map<number, AbortController>();
  private currentRun = new Map<number, number>();
  private pickingUp = false;
  /** PRs auto-pickup skipped (too small, or failed) and when, so they are retried later rather than every sweep. */
  private skippedPrs = new Map<string, number>();
  private pending = new Map<number, PendingPermission>();
  /** Planning sessions waiting for my answers to a question round, by task. */
  private waiting = new Map<number, { gateId: number; resolve(delivery: Delivery | null): void }>();
  /** "Send", "Enough" or a completed round while no session was waiting for it, by task (for one gate). */
  private queuedDelivery = new Map<number, { gateId: number; delivery: Delivery }>();
  /** Tasks I sent back for a new plan while a step ran: that step's interruption isn't a stop. */
  private replanned = new Set<number>();
  /** Malformed question rounds per task, sent back for a fix up to MAX_BAD_ROUNDS times. */
  private badRounds = new Map<number, number>();
  private timers: NodeJS.Timeout[] = [];
  private ticking = false;
  private shuttingDown = false;
  private tickAgain = false;
  private inFlight = new Set<Promise<void>>();
  private now: () => number;

  private agents: Record<Role, AgentDef>;
  private uploads: Uploads;

  constructor(private deps: PipelineDeps) {
    this.now = deps.now ?? Date.now;
    this.agents = deps.agents;
    // Same folder as the server's upload route, whichever made it.
    this.uploads = deps.uploads ?? new Uploads(deps.config.uploadsDir);
  }


  agentSkills(role: Role): string[] {
    return this.agents[role].skills;
  }

  private skillDirs(): string[] {
    return [this.deps.config.customSkillsDir, this.deps.config.skillsDir];
  }

  /** The skills agents can be given: the office's catalog, minus wrappers that only call other skills. */
  skillCatalog(): Array<{ name: string; description: string }> {
    return listSkills(this.skillDirs())
      .filter((s) => !isWrapperSkill(s.body))
      .map((s) => ({ name: s.name, description: s.description }));
  }

  /** My picks, checked: known roles, existing skills (or ones already picked, which may since be gone). */
  private ownerPicks(skills: Partial<Record<Role, string[]>> | undefined, alreadyPicked: string[] = []): SkillPicks {
    const known = new Set([...this.skillCatalog().map((s) => s.name), ...alreadyPicked]);
    const picks: SkillPicks = {};
    for (const [role, names] of Object.entries(skills ?? {}) as Array<[Role, string[]]>) {
      if (!PICKABLE_ROLES.includes(role)) throw new Error(`Skills can't be picked for the ${role}.`);
      const unknown = names.filter((n) => !known.has(n));
      if (unknown.length) throw new Error(`Unknown skill(s): ${unknown.join(', ')}.`);
      picks[role] = { skills: [...new Set(names)], by: 'owner' };
    }
    return picks;
  }

  /**
   * Changes a role's mission skills. Allowed until the role's current run: a change applies from its
   * next run (an architect re-plan, a coder fix loop).
   */
  setTaskSkills(taskId: number, role: Role, skills: string[]): Task {
    const task = this.getTask(taskId);
    if (TERMINAL_STATUSES.includes(task.status)) throw new Error(`The task is ${task.status}.`);
    if (this.running.has(taskId) && AGENT_STEPS[task.status] === role) throw new Error(`The ${role} is working right now; change its skills when it finishes.`);
    const picks = { ...task.skillPicks, ...this.ownerPicks({ [role]: skills }, task.skillPicks[role]?.skills) };
    const updated = this.update(taskId, { skillPicks: picks });
    this.deps.bus.emit(taskId, 'skills_changed', { role, skills, by: 'owner' });
    return updated;
  }

  /** Average tokens per architect/reviewer/debugger run with and without the code graph, to judge whether it pays off. */
  graphTokenStats(repoId: number): { withGraph: { runs: number; avg: number }; without: { runs: number; avg: number } } {
    const rows = this.deps.db
      .select({ r: schema.runs })
      .from(schema.runs)
      .innerJoin(schema.tasks, eq(schema.runs.taskId, schema.tasks.id))
      .where(and(eq(schema.tasks.repoId, repoId), eq(schema.runs.status, 'ok')))
      .all()
      .map((x) => x.r)
      .filter((r) => ['architect', 'reviewer', 'debugger'].includes(r.role));
    const stat = (list: typeof rows) => ({
      runs: list.length,
      avg: list.length ? Math.round(list.reduce((s, r) => s + r.inputTokens + r.outputTokens + r.cacheWriteTokens, 0) / list.length) : 0,
    });
    return { withGraph: stat(rows.filter((r) => r.graphify)), without: stat(rows.filter((r) => !r.graphify)) };
  }

  /** Swaps in edited agent definitions; running steps keep the version they started with. */
  setAgents(agents: Record<Role, AgentDef>): void {
    this.agents = agents;
  }

  /** Rebuilds a repo's Graphify graph in the background (no-op when the repo doesn't use it). */
  refreshGraph(repoId: number): void {
    const repo = this.deps.db.select().from(schema.repos).where(eq(schema.repos.id, repoId)).get();
    if (!repo?.graphify) return;
    void this.deps.graphs.build(repo).then(
      () => this.deps.bus.emit(null, 'graph_built', { repoId }),
      (e: unknown) => this.deps.bus.emit(null, 'graph_failed', { repoId, error: e instanceof Error ? e.message : String(e) }),
    );
  }

  private slugOf(repo: Repo): Promise<string | null> {
    return this.deps.slugOf ? this.deps.slugOf(repo) : originSlug(repo.path);
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
      .filter((t) => (isAgentStep(t.status) && t.status !== 'queued') || t.status === 'pushing' || t.status === 'posting_review');
    for (const t of active) {
      if (t.status === 'planning' && this.openRoundGate(t.id)) {
        // The architect was waiting for my answers: keep the questions, wait for me without a session.
        this.update(t.id, { status: 'awaiting_answer', resumeStatus: null, statusNote: this.waitingNote(t.id) });
        continue;
      }
      this.update(t.id, { status: 'paused', resumeStatus: t.status, statusNote: 'The server restarted during this step. Resume to run it again.' });
      this.deps.bus.emit(t.id, 'paused', { reason: 'server restart', step: t.status });
    }
    db.update(schema.gates)
      .set({ status: 'cancelled', decidedAt: this.now() })
      .where(and(eq(schema.gates.kind, 'command'), eq(schema.gates.status, 'pending')))
      .run();
    // A round answered completely before the restart goes on to the architect.
    for (const t of db.select().from(schema.tasks).where(eq(schema.tasks.status, 'awaiting_answer')).all()) this.deliverIfReady(t.id);
  }

  // ------------------------------------------------------------ tasks

  createTask(input: NewTask): Task {
    getRepo(this.deps.db, input.repoId);
    const text = input.input.trim();
    if (!text) throw new Error('Describe the task.');
    const title = (input.title?.trim() || text.split('\n')[0]!).slice(0, 80);
    const skillPicks = this.ownerPicks(input.skills);
    const links = cleanLinks(input.links ?? []);
    const uploads = input.attachments ?? [];
    if (uploads.length) this.uploads.check(uploads);
    let task = this.deps.db
      .insert(schema.tasks)
      .values({ repoId: input.repoId, input: text, title, kind: input.kind ?? 'feature', baseBranch: input.baseBranch ?? null, skillPicks, grillMode: input.grillMode ?? 'auto', links })
      .returning()
      .get();
    // Moved in before the first tick, so intake already sees them.
    if (uploads.length) {
      const attachments = this.uploads.claim(uploads, attachmentsDir(this.deps.docs.dir(task.id)));
      task = this.deps.db.update(schema.tasks).set({ attachments }).where(eq(schema.tasks.id, task.id)).returning().get();
    }
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
    const settings = getSettings(db);
    // Near the usage limit, start nothing new; running steps finish. Resumes when the window resets.
    if (usagePause(settings, now).paused) return;
    const slots = settings.concurrency - this.running.size;
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
        this.currentRun.delete(task.id);
        this.inFlight.delete(p);
        void this.tick();
      });
    this.inFlight.add(p);
  }

  // ------------------------------------------------------------ running a step

  private async execute(initial: Task, abort: AbortController): Promise<void> {
    const { db, bus, docs, runner, config, knowledge, graphs } = this.deps;
    let task = initial.status === 'queued' ? this.update(initial.id, { status: initial.kind === 'review' ? 'reviewing_pr' : 'intake' }) : initial;
    const step = task.status as ContractStep;
    const role = AGENT_STEPS[step]!;
    // This repo's extra skills for the role (my custom skills first, then the built-in ones).
    // Then the mission's own picks for the role. A skill deleted since it was picked is skipped, with an alert.
    const roleAgent = withSkills(
      withRepoSkills(this.agents[role], getRepo(db, initial.repoId).skills, this.skillDirs()),
      task.skillPicks[role]?.skills ?? [],
      this.skillDirs(),
      (name) => this.alert(task, 'skills', `The ${role}'s skill "${name}" no longer exists; running without it.`),
    );
    // A grilled mission's architect also follows the grilling skill, when the catalog has it.
    const grilling = step === 'planning' && task.grill;
    const grillSkill = getSettings(db).grillSkill;
    const withGrill = grilling && this.skillCatalog().some((s) => s.name === grillSkill) ? withSkills(roleAgent, [grillSkill], this.skillDirs()) : roleAgent;
    // A PR under review is untrusted code (and untrusted text): its reviewer gets exactly Read/Grep/Glob,
    // read-only, whatever a custom reviewer definition lists. No shell, no writes, no web.
    const agent: AgentDef = step === 'reviewing_pr' ? { ...roleAgent, tools: ['Read', 'Grep', 'Glob'], write: 'none' } : withGrill;
    const repo = getRepo(db, task.repoId);

    // The retrospective only reads handoff documents; the worktree may already be gone after a merge.
    if (!task.worktreePath && step === 'reviewing_pr') {
      const wt = await createReviewWorktree(repo, config.worktreesDir, task.id, task.prNumber!, task.prBaseRef!);
      task = this.update(task.id, { worktreePath: wt.path, baseSha: wt.baseSha, prHeadSha: wt.headSha });
      bus.emit(task.id, 'worktree', { path: wt.path, head: wt.headSha });
    } else if (!task.worktreePath && step !== 'retro') {
      const wt = await createWorktree(repo, config.worktreesDir, task.id, task.title, task.baseBranch ?? repo.defaultBranch);
      task = this.update(task.id, { worktreePath: wt.path, branch: wt.branch, baseSha: wt.baseSha });
      bus.emit(task.id, 'worktree', { path: wt.path, branch: wt.branch });
    }
    const worktree = step === 'retro' ? realPath(docs.dir(task.id)) : task.worktreePath!;
    if (abort.signal.aborted) return; // stopped or discarded while the worktree was being made

    const feedback = task.feedback ?? undefined;
    if (feedback) task = this.update(task.id, { feedback: null });
    const mcpServers = graphs.mcpFor(repo, role);
    const prompt = buildPrompt(step, {
      knowledge: knowledge.read(repo.id),
      graph: !!mcpServers,
      task,
      repo,
      docs,
      worktree,
      feedback,
      diff: (step === 'reviewing' || step === 'reviewing_pr') && task.baseSha ? await diff(worktree, task.baseSha) : undefined,
      ...(step === 'intake'
        ? { catalog: this.skillCatalog(), roleSkills: Object.fromEntries(PICKABLE_ROLES.map((r) => [r, this.agents[r].skills])) }
        : {}),
      ...(grilling ? { briefing: { hasSkill: withGrill !== roleAgent } } : {}),
      attachmentsDir: realPath(attachmentsDir(docs.dir(task.id))),
    });

    const run = db
      .insert(schema.runs)
      .values({ taskId: task.id, role, step, model: agent.model, effort: agent.effort ?? null, status: 'running', graphify: !!mcpServers })
      .returning()
      .get();
    this.currentRun.set(task.id, run.id);
    bus.emit(task.id, 'step_start', { step, role, model: agent.model, effort: agent.effort, skills: agent.skills }, run.id);

    const outcome = await runner.run({
      taskId: task.id,
      runId: run.id,
      role,
      agent,
      prompt,
      cwd: worktree,
      mcpServers,
      // No shell for PR reviews (see above); the empty allow-list makes any Bash call that slips through ask me.
      guard: {
        worktree,
        write: agent.write,
        testGlobs: repo.testGlobs,
        allowlist: step === 'reviewing_pr' ? [] : effectiveAllowlist(repo),
        ...(task.attachments.length ? { readRoots: [realPath(attachmentsDir(docs.dir(task.id)))] } : {}),
      },
      signal: abort.signal,
      onEvent: (type, payload) => bus.emit(task.id, type, payload, run.id),
      askPermission: (subject, unmatched) => this.requestPermission(task.id, subject, unmatched),
      validate: (text) => validateDoc(step, text),
      ...(grilling ? { interject: (text: string) => this.onArchitectMessage(task.id, run.id, text, abort.signal) } : {}),
    });
    this.recordRun(run.id, outcome);
    bus.emit(task.id, 'step_end', { step, role, status: outcome.status, error: outcome.error, usage: outcome.usage }, run.id);

    task = this.getTask(task.id);
    // Sent back for a new plan while running: replanNow already set the next step.
    if (this.replanned.delete(task.id) && outcome.status === 'interrupted') return;
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
      case 'parked':
        // Nobody answered within the wait: free the slot and keep the questions open for me.
        this.update(task.id, { status: 'awaiting_answer', resumeStatus: null, statusNote: this.waitingNote(task.id) });
        this.deps.bus.emit(task.id, 'briefing_parked', {});
        this.deliverIfReady(task.id);
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
        const m = readMeta<{
          title: string;
          kind: TaskKind;
          size: 'S' | 'M' | 'L';
          needs_debugger: boolean;
          needs_researcher: boolean;
          design_review: boolean;
          skills?: unknown;
          skills_why?: unknown;
          grill?: boolean;
          grill_reason?: string;
        }>('intake', text);
        const updated = this.update(task.id, {
          title: m.title,
          kind: m.kind,
          size: m.size,
          needsDebugger: m.needs_debugger,
          needsResearcher: m.needs_researcher,
          designFlag: m.design_review,
          skillPicks: this.managerPicks(task, m.skills, m.skills_why),
          ...this.grillDecision(task, m.grill, m.grill_reason),
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
      case 'retro': {
        this.update(task.id, { status: 'done', doneAt: this.now(), statusNote: null });
        const note = proposalFromRetro(text);
        if (note) {
          this.deps.knowledge.propose(task.repoId, task.id, note);
          this.alert(task, 'knowledge', `Suggested note for the repo's knowledge file: ${note}`);
        }
        this.refreshGraph(task.repoId);
        return;
      }
      case 'reviewing_pr': {
        const { summary, comments } = parseReviewDoc(text);
        const { db } = this.deps;
        db.delete(schema.reviewComments).where(eq(schema.reviewComments.taskId, task.id)).run();
        if (comments.length) db.insert(schema.reviewComments).values(comments.map((c) => ({ taskId: task.id, ...c }))).run();
        this.update(task.id, { reviewSummary: summary, status: 'awaiting_review_post' });
        this.openGate(task.id, 'review_post');
        return;
      }
    }
  }

  /** The manager's picks for the roles I left empty. Unknown names are dropped and reported. */
  private managerPicks(task: Task, skills: unknown, why: unknown): SkillPicks {
    const known = new Set(this.skillCatalog().map((s) => s.name));
    const picks: SkillPicks = { ...task.skillPicks };
    const dropped: string[] = [];
    const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
    const reasons = isMap(why) ? why : {};
    for (const [role, raw] of Object.entries(isMap(skills) ? skills : {})) {
      if (!PICKABLE_ROLES.includes(role as Role) || picks[role as Role]?.by === 'owner') continue;
      // A single name instead of a list is fine too.
      const names = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []).map(String);
      const kept = [...new Set(names)].slice(0, MAX_MANAGER_PICKS).filter((n) => {
        if (known.has(n)) return true;
        dropped.push(n);
        return false;
      });
      if (kept.length) picks[role as Role] = { skills: kept, by: 'manager', ...(reasons[role] ? { why: String(reasons[role]).slice(0, 200) } : {}) };
    }
    if (dropped.length) this.alert(task, 'skills', `The manager picked skills that aren't in the catalog, left out: ${[...new Set(dropped)].join(', ')}.`);
    const added = Object.entries(picks).filter(([r, p]) => p?.by === 'manager' && task.skillPicks[r as Role]?.by !== 'owner');
    if (added.length) this.deps.bus.emit(task.id, 'skills_picked', { picks: Object.fromEntries(added) });
    return picks;
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
    this.deps.bus.emit(task.id, 'replanned', { count: task.replanCount + 1 });
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
    if (gate.kind === 'question') throw new Error('Answer the questions instead.');

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
    const expected = gate.kind === 'plan' ? 'awaiting_plan_approval' : gate.kind === 'push' ? 'awaiting_push_approval' : 'awaiting_review_post';
    if (task.status !== expected) throw new Error(`The task is ${task.status}, not ${expected}.`);
    close(decision === 'approve' ? 'approved' : 'rejected');
    this.deps.bus.emit(task.id, 'gate_decided', { gateId, kind: gate.kind, decision, comment });

    if (gate.kind === 'review_post') {
      if (decision === 'approve') await this.postReview(task);
      else this.update(task.id, { status: 'reviewing_pr', feedback: `The owner wants the draft review redone:\n\n${comment}\n\n### Previous draft\n${this.deps.docs.latest(task.id, 'pr-review') ?? ''}` });
    } else if (gate.kind === 'plan') {
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
      const url = await this.deps.publisher.pushAndOpenDraftPr(repo, task.worktreePath!, task.branch!, { title, body, base: task.baseBranch ?? repo.defaultBranch });
      this.update(task.id, { status: 'pr_open', prUrl: url });
      this.deps.bus.emit(task.id, 'pr_opened', { url });
    } catch (e) {
      this.block(task, `Push failed: ${e instanceof Error ? e.message : String(e)}`, 'pushing');
    }
  }

  // ------------------------------------------------------------ briefing

  /** Whether the architect grills me: my Always/Never wins; on Auto the manager decides at intake. */
  private grillDecision(task: Task, managerSays: boolean | undefined, reason: string | undefined): Pick<Task, 'grill' | 'grillReason'> {
    if (task.kind === 'review') return { grill: false, grillReason: null };
    const grill = task.grillMode === 'always' ? true : task.grillMode === 'never' ? false : !!managerSays;
    const grillReason =
      task.grillMode === 'always'
        ? 'You set Grill me to Always.'
        : task.grillMode === 'never'
          ? 'You set Grill me to Never.'
          : reason?.trim() || (grill ? 'The manager asked for a briefing.' : null);
    this.deps.bus.emit(task.id, 'briefing_decided', { grill, reason: grillReason, mode: task.grillMode });
    return { grill, grillReason };
  }

  questions(taskId: number): Question[] {
    return this.deps.db.select().from(schema.questions).where(eq(schema.questions.taskId, taskId)).orderBy(asc(schema.questions.id)).all();
  }

  private openRoundGate(taskId: number): Gate | undefined {
    return this.pendingGates(taskId).find((g) => g.kind === 'question');
  }

  private waitingNote(taskId: number): string {
    const gate = this.openRoundGate(taskId);
    const open = gate ? this.questions(taskId).filter((q) => q.gateId === gate.id && q.answer === null && !q.delegated).length : 0;
    return `The architect is waiting for your answers${open ? ` (${open} open question${open === 1 ? '' : 's'})` : ''}. Planning continues when you answer.`;
  }

  /** "Enough" holds until the plan is sent back (a re-plan may need new answers). */
  private briefingEnded(taskId: number): boolean {
    const events = this.deps.db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.taskId, taskId), inArray(schema.events.type, ['briefing_ended', 'replanned', 'replan_requested'])))
      .orderBy(asc(schema.events.id))
      .all();
    return events.at(-1)?.type === 'briefing_ended';
  }

  /**
   * The architect's final message on a grilled mission. A question round is stored and shown to me,
   * and the session waits for my answers (string: sent back into the session; "park": nobody
   * answered in time). Anything else is the plan (null).
   */
  private async onArchitectMessage(taskId: number, runId: number, text: string, signal: AbortSignal): Promise<string | 'park' | null> {
    const round = parseRound(text);
    if (round === null) return null;
    if (typeof round === 'string') {
      const bad = (this.badRounds.get(taskId) ?? 0) + 1;
      this.badRounds.set(taskId, bad);
      return bad <= MAX_BAD_ROUNDS ? round : null; // then it fails as a plan, with the plan's own correction
    }
    if (this.briefingEnded(taskId)) {
      // Asked again after "enough": remind it, but not forever.
      const bad = (this.badRounds.get(taskId) ?? 0) + 1;
      this.badRounds.set(taskId, bad);
      return bad <= MAX_BAD_ROUNDS ? 'The owner already said that is enough questions. Write the plan now; put anything still open under Risks as an assumption.' : null;
    }
    this.badRounds.delete(taskId);
    const gate = this.openRound(taskId, runId, round);
    const delivery = await this.waitForRound(taskId, gate.id, signal);
    if (delivery === null) return 'park';
    return this.closeRound(taskId, gate.id, delivery);
  }

  private openRound(taskId: number, runId: number, round: RoundQuestion[]): Gate {
    // A round left open by an earlier session (a failed step, then resume) is replaced, not stacked.
    for (const old of this.pendingGates(taskId).filter((g) => g.kind === 'question')) {
      this.deps.db.update(schema.gates).set({ status: 'cancelled', decidedAt: this.now() }).where(eq(schema.gates.id, old.id)).run();
    }
    if (this.queuedDelivery.get(taskId)) this.queuedDelivery.delete(taskId);
    const number = Math.max(0, ...this.questions(taskId).map((q) => q.round)) + 1;
    const gate = this.openGate(taskId, 'question', `Round ${number}: ${round.length} question${round.length === 1 ? '' : 's'}`);
    this.deps.db
      .insert(schema.questions)
      .values(
        round.map((q, idx) => ({
          taskId,
          gateId: gate.id,
          runId,
          round: number,
          idx,
          title: q.title,
          body: q.question,
          options: q.options,
          recommended: q.recommended ?? null,
        })),
      )
      .run();
    const task = this.update(taskId, { statusNote: this.waitingNote(taskId) });
    this.deps.bus.emit(taskId, 'question_round', { gateId: gate.id, round: number, count: round.length });
    this.deps.bus.taskChanged(task);
    return gate;
  }

  /** Resolves with how the round was delivered, or null when the wait ran out or the step was stopped. */
  private waitForRound(taskId: number, gateId: number, signal: AbortSignal): Promise<Delivery | null> {
    return new Promise((resolve) => {
      const done = (d: Delivery | null) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (this.waiting.get(taskId)?.gateId === gateId) this.waiting.delete(taskId);
        resolve(d);
      };
      const onAbort = () => done(null);
      const timer = setTimeout(() => done(null), this.deps.briefingWaitMs ?? BRIEFING_WAIT_MS);
      if (signal.aborted) return done(null);
      signal.addEventListener('abort', onAbort);
      this.waiting.set(taskId, { gateId, resolve: done });
      // Answered already (fast, or before a restart): deliver straight away.
      const queued = this.queuedDelivery.get(taskId);
      if (queued?.gateId === gateId) {
        this.queuedDelivery.delete(taskId);
        done(queued.delivery);
      } else if (this.roundComplete(gateId)) done('complete');
    });
  }

  private roundComplete(gateId: number): boolean {
    const qs = this.deps.db.select().from(schema.questions).where(eq(schema.questions.gateId, gateId)).all();
    return qs.length > 0 && qs.every((q) => q.answer !== null || q.delegated);
  }

  /** Closes a round: brief.md is updated and the answers message for the architect is returned. */
  private closeRound(taskId: number, gateId: number, delivery: Delivery): string {
    const { db, docs, bus } = this.deps;
    const qs = db.select().from(schema.questions).where(eq(schema.questions.gateId, gateId)).orderBy(asc(schema.questions.idx)).all();
    const task = this.getTask(taskId);
    // Messages I sent while the round was open were held back, so the architect gets them with the answers.
    const notes = task.feedback ? [task.feedback] : [];
    if (this.queuedDelivery.get(taskId)?.gateId === gateId) this.queuedDelivery.delete(taskId);
    db.update(schema.gates).set({ status: 'approved', decision: delivery, decidedAt: this.now() }).where(eq(schema.gates.id, gateId)).run();
    docs.save(taskId, 'brief', briefDoc(this.questions(taskId)));
    this.update(taskId, { feedback: null, statusNote: null });
    bus.emit(taskId, 'gate_decided', { gateId, kind: 'question', decision: delivery });
    if (delivery === 'enough') bus.emit(taskId, 'briefing_ended', {});
    return answersMessage(qs[0]?.round ?? 0, qs, delivery, notes);
  }

  /** My answer to one question, from the board or Slack. The first answer counts. */
  answerQuestion(questionId: number, answer: { text?: string; delegate?: boolean }, via: 'board' | 'slack'): Question {
    const { db, bus } = this.deps;
    const q = db.select().from(schema.questions).where(eq(schema.questions.id, questionId)).get();
    if (!q) throw new Error(`No question ${questionId}`);
    if (q.answer !== null || q.delegated) throw new Error(`Already answered${q.answeredVia ? ` on ${q.answeredVia === 'slack' ? 'Slack' : 'the board'}` : ''}.`);
    const gate = q.gateId ? db.select().from(schema.gates).where(eq(schema.gates.id, q.gateId)).get() : undefined;
    if (!gate || gate.status !== 'pending') throw new Error('This round is closed.');
    const text = answer.text?.trim();
    if (!answer.delegate && !text) throw new Error('Write an answer, or let the architect decide.');
    const updated = db
      .update(schema.questions)
      .set({ answer: answer.delegate ? null : text!.slice(0, 4000), delegated: !!answer.delegate, answeredVia: via, answeredAt: this.now() })
      .where(eq(schema.questions.id, questionId))
      .returning()
      .get();
    bus.emit(q.taskId, 'question_answered', { questionId, gateId: gate.id, via, delegated: !!answer.delegate, answer: updated.answer });
    // brief.md is kept current, so answers survive even a round that gets cancelled.
    this.deps.docs.save(q.taskId, 'brief', briefDoc(this.questions(q.taskId)));
    if (this.roundComplete(gate.id)) this.deliver(q.taskId, gate.id, 'complete');
    else this.update(q.taskId, { statusNote: this.waitingNote(q.taskId) });
    return updated;
  }

  /** "Send what I've answered" or "Enough, start planning", for the open round. */
  briefingAction(taskId: number, action: 'send' | 'enough'): void {
    const gate = this.openRoundGate(taskId);
    if (!gate) throw new Error('No questions are waiting.');
    const qs = this.questions(taskId).filter((q) => q.gateId === gate.id);
    if (action === 'send' && !qs.some((q) => q.answer !== null || q.delegated)) throw new Error('Answer at least one question first.');
    this.deliver(taskId, gate.id, action);
  }

  /** Hands the round to the waiting session, or resumes planning when the session has parked. */
  private deliver(taskId: number, gateId: number, delivery: Delivery): void {
    const waiting = this.waiting.get(taskId);
    if (waiting?.gateId === gateId) return waiting.resolve(delivery);
    const task = this.getTask(taskId);
    if (task.status !== 'awaiting_answer') {
      // Between the session's wait and its parking (or stopped): delivered once it parks or resumes.
      this.queuedDelivery.set(taskId, { gateId, delivery });
      return;
    }
    const message = this.closeRound(taskId, gateId, delivery);
    this.update(taskId, { status: 'planning', resumeStatus: null, statusNote: null, feedback: message });
    this.deps.bus.emit(taskId, 'briefing_resumed', { delivery });
    void this.tick();
  }

  /** After parking or resuming: a round that's already answered (or sent) goes straight on. */
  private deliverIfReady(taskId: number): void {
    const gate = this.openRoundGate(taskId);
    if (!gate) {
      // Parked with no open round (it was cancelled): plan again.
      if (this.getTask(taskId).status === 'awaiting_answer') this.update(taskId, { status: 'planning', statusNote: null });
      return;
    }
    const queued = this.queuedDelivery.get(taskId);
    this.queuedDelivery.delete(taskId);
    if (queued?.gateId === gate.id) this.deliver(taskId, gate.id, queued.delivery);
    else if (this.roundComplete(gate.id)) this.deliver(taskId, gate.id, 'complete');
  }

  // ------------------------------------------------------------ steering

  /** Sends my instruction to the running agent, or keeps it for the next step. */
  steer(taskId: number, text: string): 'live' | 'next_step' {
    const task = this.getTask(taskId);
    if (TERMINAL_STATUSES.includes(task.status)) throw new Error(`The task is ${task.status}.`);
    const runId = this.currentRun.get(taskId);
    const message = `Message from the owner, follow it: ${text}`;
    if (runId !== undefined && this.deps.runner.steer(runId, message)) {
      this.deps.bus.emit(taskId, 'steered', { text, live: true }, runId);
      return 'live';
    }
    this.update(taskId, { feedback: [task.feedback, `The owner says: ${text}`].filter(Boolean).join('\n\n') });
    this.deps.bus.emit(taskId, 'steered', { text, live: false });
    return 'next_step';
  }

  /** I ask for a new plan: stop whatever runs and send the task back to the architect. Doesn't count toward the re-plan limit. */
  replanNow(taskId: number, reason: string): Task {
    const task = this.getTask(taskId);
    if ([...TERMINAL_STATUSES, 'pushing', 'pr_open', 'retro'].includes(task.status)) throw new Error(`The task is ${task.status}; it can't be re-planned.`);
    this.cancelGates(taskId);
    const previous = this.deps.docs.latest(taskId, 'plan');
    const updated = this.update(taskId, {
      status: 'planning',
      resumeStatus: null,
      resumeAt: null,
      statusNote: null,
      loopCount: 0,
      feedback: `The owner asked for a new plan: ${reason}${previous ? `\n\n### Previous plan (revise it)\n${previous}` : ''}`,
    });
    if (this.running.has(taskId)) this.replanned.add(taskId);
    this.running.get(taskId)?.abort();
    this.deps.bus.emit(taskId, 'replan_requested', { reason });
    void this.tick();
    return updated;
  }

  // ------------------------------------------------------------ actions

  async action(taskId: number, action: TaskAction): Promise<Task> {
    const task = this.getTask(taskId);
    switch (action) {
      case 'stop': {
        if (TERMINAL_STATUSES.includes(task.status) || task.status === 'stopped') throw new Error(`The task is ${task.status}.`);
        this.cancelPermissions(taskId);
        // Stopped while the architect waits for my answers: resuming goes back to waiting for them.
        const resumeStatus =
          task.status === 'planning' && this.openRoundGate(taskId)
            ? 'awaiting_answer'
            : task.status === 'paused' || task.status === 'blocked'
              ? task.resumeStatus
              : task.status;
        const stopped = this.update(taskId, { status: 'stopped', resumeStatus, resumeAt: null });
        this.running.get(taskId)?.abort();
        this.deps.bus.emit(taskId, 'stopped', {});
        return stopped;
      }
      case 'resume': {
        if (!['stopped', 'paused', 'blocked'].includes(task.status)) throw new Error(`The task is ${task.status}; nothing to resume.`);
        const target = task.resumeStatus ?? 'queued';
        this.deps.bus.emit(taskId, 'resumed', { status: target });
        if (target === 'posting_review') {
          await this.postReview(task, true);
          return this.getTask(taskId);
        }
        if (target === 'pushing') {
          await this.push(task);
          return this.getTask(taskId);
        }
        const resumed = this.update(taskId, {
          status: target,
          resumeStatus: null,
          resumeAt: null,
          statusNote: target === 'awaiting_answer' ? this.waitingNote(taskId) : null,
        });
        if (target === 'awaiting_answer') this.deliverIfReady(taskId);
        void this.tick();
        return this.getTask(taskId);
      }
      case 'discard': {
        if (task.status === 'discarded') return task;
        this.cancelGates(taskId);
        const discarded = this.update(taskId, { status: 'discarded', statusNote: null });
        this.running.get(taskId)?.abort();
        if (task.worktreePath) {
          await removeWorktree(getRepo(this.deps.db, task.repoId), task.worktreePath, task.id).catch(() => {});
          this.update(taskId, { worktreePath: null });
        }
        this.deps.bus.emit(taskId, 'discarded', {});
        return discarded;
      }
      case 'done': {
        if (!['pr_open', 'blocked', 'stopped', 'awaiting_push_approval', 'awaiting_review_post'].includes(task.status)) {
          throw new Error(`The task is ${task.status}; it cannot be marked done.`);
        }
        this.cancelGates(taskId);
        // Reviews have no retrospective: done means done.
        const done =
          task.kind === 'review'
            ? this.update(taskId, { status: 'done', doneAt: this.now(), statusNote: null, resumeStatus: null })
            : this.update(taskId, { status: 'retro', statusNote: null, resumeStatus: null });
        void this.tick();
        return done;
      }
    }
  }

  /** A finished or discarded task leaves no gate waiting for me. */
  private cancelGates(taskId: number): void {
    this.cancelPermissions(taskId);
    this.queuedDelivery.delete(taskId); // a waiting session sees its abort signal
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

  // ------------------------------------------------------------ PR reviews

  /** Finds the registered repo for a PR. Reviews need a local checkout to read the code around the diff. */
  private async repoForSlug(slug: string): Promise<Repo | null> {
    for (const repo of this.deps.db.select().from(schema.repos).all()) {
      if ((await this.slugOf(repo)) === slug) return repo;
    }
    return null;
  }

  async createReviewTask(prUrl: string, source: 'manual' | 'auto' = 'manual', known?: { repo: Repo; info: PrInfo }): Promise<Task> {
    const ref = parsePrUrl(prUrl);
    const slug = prSlug(ref);
    const repo = known?.repo ?? (await this.repoForSlug(slug));
    if (!repo) throw new Error(`${slug} isn't a registered repo. Add its local checkout under Repos first.`);
    const pr = known?.info ?? (await this.deps.publisher.prInfo(repo, slug, ref.number));
    if (pr.state !== 'open') throw new Error(`PR #${ref.number} is ${pr.state}.`);
    const url = canonicalPrUrl(slug, ref.number);
    const task = this.deps.db
      .insert(schema.tasks)
      .values({
        repoId: repo.id,
        kind: 'review',
        title: `Review #${ref.number}: ${pr.title}`.slice(0, 80),
        input: `${url}\n\n${pr.body}`.trim(),
        prUrl: url,
        prNumber: ref.number,
        prRepo: slug,
        prAuthor: pr.author,
        prHeadSha: pr.headSha,
        prHeadRef: pr.headRef,
        prBaseRef: pr.baseRef,
      })
      .returning()
      .get();
    this.deps.bus.emit(task.id, 'created', { title: task.title, review: true, source });
    this.deps.bus.taskChanged(task);
    void this.tick();
    return task;
  }

  reviewComments(taskId: number) {
    return this.deps.db.select().from(schema.reviewComments).where(eq(schema.reviewComments.taskId, taskId)).all();
  }

  editReviewComment(commentId: number, patch: { body?: string; deleted?: boolean }) {
    const c = this.deps.db.select().from(schema.reviewComments).where(eq(schema.reviewComments.id, commentId)).get();
    if (!c) throw new Error(`No comment ${commentId}`);
    if (this.getTask(c.taskId).status !== 'awaiting_review_post') throw new Error('This review is no longer a draft.');
    return this.deps.db.update(schema.reviewComments).set(patch).where(eq(schema.reviewComments.id, commentId)).returning().get();
  }

  editReviewSummary(taskId: number, summary: string): Task {
    if (this.getTask(taskId).status !== 'awaiting_review_post') throw new Error('This review is no longer a draft.');
    return this.update(taskId, { reviewSummary: summary });
  }

  /**
   * Posts the edited draft. `resuming` is true only when continuing an interrupted post: then GitHub may
   * already have it, recognised by this task's marker in the body (never by author or commit, which
   * would match reviews I wrote by hand).
   */
  private async postReview(task: Task, resuming = false): Promise<void> {
    task = this.update(task.id, { status: 'posting_review', statusNote: null });
    const repo = getRepo(this.deps.db, task.repoId);
    const marker = reviewMarker(task.id);
    try {
      const existing = resuming ? await this.deps.publisher.findReviewWithMarker(repo, task.prRepo!, task.prNumber!, marker) : null;
      if (existing) {
        this.update(task.id, { status: 'done', doneAt: this.now(), reviewPostedUrl: existing });
        this.deps.bus.emit(task.id, 'review_posted', { url: existing, alreadyPosted: true });
        await this.dropWorktree(this.getTask(task.id));
        return;
      }
      const kept = this.reviewComments(task.id).filter((c) => !c.deleted);
      // Committed PR changes only: anything the reviewer's commands touched in the worktree must not count.
      const prDiff = task.worktreePath && task.baseSha ? await diff(task.worktreePath, task.baseSha, Number.MAX_SAFE_INTEGER, true) : '';
      const { inline, general } = splitComments(kept, commentableLines(prDiff));
      const url = await this.deps.publisher.postReview(repo, task.prRepo!, task.prNumber!, {
        commitId: task.prHeadSha!,
        body: `${reviewBody(task.reviewSummary ?? '', general)}\n\n${marker}`,
        comments: inline.map((c) => ({ path: c.path, line: c.line, body: formatComment(c) })),
      });
      this.update(task.id, { status: 'done', doneAt: this.now(), reviewPostedUrl: url });
      this.deps.bus.emit(task.id, 'review_posted', { url, inline: inline.length, general: general.length });
      await this.dropWorktree(this.getTask(task.id));
    } catch (e) {
      // Back to the editable draft, so I can fix whatever GitHub rejected and post again.
      const note = `Posting the review failed: ${e instanceof Error ? e.message : String(e)}`;
      this.update(task.id, { status: 'awaiting_review_post', statusNote: note });
      this.alert(task, 'post_failed', note);
      this.openGate(task.id, 'review_post');
    }
  }

  /** On my own PR: turn the review's blocking findings into a coder task whose draft PR targets my PR's branch. */
  async fixIt(reviewTaskId: number): Promise<Task> {
    const review = this.getTask(reviewTaskId);
    if (review.kind !== 'review' || !review.prHeadRef) throw new Error('Only review tasks can be fixed.');
    const repo = getRepo(this.deps.db, review.repoId);
    const me = await this.deps.publisher.login(repo.ghAccount);
    if (me.toLowerCase() !== (review.prAuthor ?? '').toLowerCase()) throw new Error(`"Fix it" is for your own PRs; #${review.prNumber} is by ${review.prAuthor}.`);
    const info = await this.deps.publisher.prInfo(repo, review.prRepo!, review.prNumber!);
    if (info.headRepo !== review.prRepo) throw new Error(`"Fix it" only works when the PR branch is in ${review.prRepo} itself, not a fork.`);
    const findings = this.reviewComments(reviewTaskId).filter((c) => !c.deleted && c.severity === 'blocking');
    if (!findings.length) throw new Error('The review has no blocking findings to fix.');
    return this.createTask({
      repoId: review.repoId,
      kind: 'bug',
      title: `Fix review findings on #${review.prNumber}`,
      baseBranch: review.prHeadRef,
      input: [
        `Fix these blocking review findings on PR ${review.prUrl} (branch ${review.prHeadRef}). The work lands as a draft PR into that branch.`,
        ...findings.map((c) => `- ${c.path}:${c.line} — ${c.body}`),
      ].join('\n'),
    });
  }

  /** Queues reviews for open PRs that request my review, in registered repos, once per PR. */
  async pickUpReviews(): Promise<number> {
    if (this.pickingUp) return 0; // the timer, startup sweep and the "check now" button must not overlap
    this.pickingUp = true;
    try {
      return await this.pickUpReviewsOnce();
    } finally {
      this.pickingUp = false;
    }
  }

  private async pickUpReviewsOnce(): Promise<number> {
    const { db, publisher } = this.deps;
    const settings = getSettings(db);
    if (!settings.reviewAutoPickup) return 0;
    const repos = db.select().from(schema.repos).all();
    const slugs = new Map<string, Repo>();
    for (const r of repos) {
      const slug = await this.slugOf(r);
      if (slug) slugs.set(slug, r);
    }
    const seen = new Set(
      db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.kind, 'review'))
        .all()
        .map((t) => t.prUrl?.toLowerCase()),
    );
    let created = 0;
    for (const account of new Set(repos.map((r) => r.ghAccount))) {
      const requests = await publisher.reviewRequests(account).catch(() => []);
      for (const pr of requests) {
        const url = canonicalPrUrl(pr.repo, pr.number);
        const repo = slugs.get(pr.repo);
        const skippedAt = this.skippedPrs.get(url);
        if (!repo || (repo.ghAccount ?? null) !== account || seen.has(url) || (skippedAt && this.now() - skippedAt < PICKUP_RETRY_MS)) continue;
        seen.add(url);
        try {
          const info = await publisher.prInfo(repo, pr.repo, pr.number);
          if (info.changedLines < settings.reviewMinLines) {
            this.skippedPrs.set(url, this.now()); // too small: re-check in an hour, not every sweep
            continue;
          }
          await this.createReviewTask(url, 'auto', { repo, info });
          created++;
        } catch (e) {
          this.skippedPrs.set(url, this.now());
          this.deps.bus.emit(null, 'pickup_failed', { url, error: e instanceof Error ? e.message : String(e) });
        }
      }
    }
    return created;
  }

  // ------------------------------------------------------------ housekeeping

  /** Detects merged PRs and removes old worktrees. */
  async sweep(): Promise<void> {
    const { db, publisher } = this.deps;
    await this.pickUpReviews().catch(() => 0);
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
    await removeWorktree(getRepo(this.deps.db, t.repoId), t.worktreePath, t.id).catch(() => {});
    this.update(t.id, { worktreePath: null });
  }
}
