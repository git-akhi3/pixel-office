import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAgents } from '../server/src/agents.js';
import { ensureDirs, loadConfig, type OfficeConfig } from '../server/src/config.js';
import { eq } from 'drizzle-orm';
import { openDb, schema, setSetting, type Db } from '../server/src/db/index.js';
import type { Repo, Task } from '../server/src/db/schema.js';
import type { TaskStatus } from '../server/src/domain.js';
import { EventBus } from '../server/src/events.js';
import type { PostedReview, PrInfo, Publisher, ReviewRequest } from '../server/src/github.js';
import { TaskDocs } from '../server/src/handoffs.js';
import { Graphs } from '../server/src/graph.js';
import { Knowledge } from '../server/src/knowledge.js';
import { Pipeline } from '../server/src/pipeline.js';
import { createRepo, getRepo } from '../server/src/repos.js';
import { emptyUsage, type AgentRunner, type RunOutcome, type RunRequest } from '../server/src/runner.js';

const appDir = resolve(import.meta.dirname, '..');

// ---------------------------------------------------------------- fakes

const docs = {
  task: (o: Partial<{ debugger: boolean; lane: string; size: string; epic: boolean; frontend: boolean }> = {}) =>
    `---\ntitle: Add greeting\nkind: feature\nsize: ${o.size ?? 'S'}\n${o.lane ? `lane: ${o.lane}\n` : ''}${o.epic ? 'epic: true\n' : ''}${o.frontend ? 'frontend: true\n' : ''}needs_debugger: ${!!o.debugger}\nneeds_researcher: false\ndesign_review: false\n---\n## Request\nAdd a greeting.\n\n## Draft acceptance criteria\n- greet() returns hello`,
  diagnosis: '---\nreproduced: true\n---\n## Root cause\nx',
  plan: '---\nfiles_in_scope:\n  - src/**\ntoken_estimate: 1000\n---\n## Goal\nAdd greet().\n\n## Steps\n1. src/greet.ts: add greet()',
  changes: '---\nstatus: done\n---\n## Changes\n- Step 1: added src/greet.ts\n\n## PR\n**Title:** Add greet helper\n**Summary:**\n- adds greet()\n**How it was tested:** npm test',
  blocked: '---\nstatus: blocked\n---\n## Question\nThe plan names a file that does not exist.',
  reviewPass: '---\nverdict: pass\nblocking: 0\n---\n## Summary\nfine\n\n## Findings\n- none',
  reviewFail: '---\nverdict: fail\nblocking: 1\n---\n## Summary\nbug\n\n## Findings\n- [blocking] src/greet.ts:1 — wrong',
  testPass: '---\nresult: pass\ntests_added: 1\n---\n## Suite\nnpm test: 1 passed',
  testFail: '---\nresult: fail\ntests_added: 1\n---\n## Suite\nnpm test: 1 failed',
  retro: '---\n---\n- **Went well:** fast\n- **Went wrong:** none\n- **Knowledge-file edit:** none',
  prReview:
    '---\nverdict: request_changes\n---\n## Summary\nAdds a feature; one bug.\n\n## Comments\n- [blocking] src/feature.ts:2 — returns the wrong value\n- [nit] README.md:1 — unrelated line\n- [suggestion] src/feature.ts:1 — rename',
};

type Script = (req: RunRequest) => Promise<Partial<RunOutcome> & { text?: string }> | (Partial<RunOutcome> & { text?: string });

class FakeRunner implements AgentRunner {
  calls: Array<{ step: string; role: string; prompt: string; model?: string; effort?: string; skills: string[]; readRoots?: string[]; resume?: { sessionId: string; prompt: string } }> = [];
  active = 0;
  maxActive = 0;
  overrides: Partial<Record<string, Script[]>> = {};

  constructor(private stepOf: (taskId: number) => TaskStatus) {}

  queue(step: string, ...scripts: Script[]): void {
    this.overrides[step] = [...(this.overrides[step] ?? []), ...scripts];
  }

  steer(_runId: number, _text: string): boolean {
    return false;
  }

  async run(req: RunRequest): Promise<RunOutcome> {
    const step = this.stepOf(req.taskId);
    this.calls.push({ step, role: req.role, prompt: req.prompt, skills: req.agent.skills, model: req.agent.model, effort: req.agent.effort, readRoots: req.guard.readRoots, resume: req.resume });
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      const script = this.overrides[step]?.shift();
      const result = script ? await script(req) : { text: this.defaultText(step, req) };
      return { status: 'ok', text: '', sessionId: `session-${req.runId}`, usage: { ...emptyUsage(), input: 100, output: 50 }, durationMs: 1, ...result };
    } finally {
      this.active--;
    }
  }

  private defaultText(step: string, req: RunRequest): string {
    switch (step) {
      case 'intake':
        return docs.task();
      case 'debugging':
        return docs.diagnosis;
      case 'planning':
        return docs.plan;
      case 'coding':
        writeFileSync(join(req.cwd, 'src', 'greet.ts'), `export const greet = () => 'hello ${Math.random()}';\n`);
        return docs.changes;
      case 'reviewing':
        return docs.reviewPass;
      case 'testing':
        writeFileSync(join(req.cwd, 'src', 'greet.test.ts'), `// test ${Math.random()}\n`);
        return docs.testPass;
      case 'retro':
        return docs.retro;
      case 'reviewing_pr':
        return docs.prReview;
      default:
        throw new Error(`no default for ${step}`);
    }
  }
}

/** Waits for the abort signal, like a long-running agent. */
const hang: Script = (req) =>
  new Promise((res) => {
    if (req.signal.aborted) return res({ status: 'interrupted', text: '' });
    req.signal.addEventListener('abort', () => res({ status: 'interrupted', text: '' }));
  });

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
    await pipeline.tick();
  }
}

class FakePublisher implements Publisher {
  pushed: string[] = [];
  bases: string[] = [];
  state: 'OPEN' | 'MERGED' | 'CLOSED' = 'OPEN';
  posted: PostedReview[] = [];
  me = 'octo';
  requests: ReviewRequest[] = [];
  drafts: boolean[] = [];
  merged: Array<{ url: string; method: string; headSha?: string }> = [];
  retargeted: Array<{ url: string; base: string }> = [];
  failMerge: string | null = null;
  /** Set to hold pushes or merges until released (a slow network), or to make the push fail. */
  hold: Promise<void> | null = null;
  failPush: string | null = null;
  async pushAndOpenPr(_repo: Repo, _wt: string, branch: string, pr: { base: string; draft: boolean }): Promise<string> {
    if (this.hold) await this.hold;
    if (this.failPush) throw new Error(this.failPush);
    // Like gh: a branch that already has a PR keeps it.
    const existing = this.pushed.indexOf(branch);
    this.pushed.push(branch);
    this.bases.push(pr.base);
    this.drafts.push(pr.draft);
    return `https://github.com/acme/app/pull/${100 + (existing >= 0 ? existing + 1 : this.pushed.length)}`;
  }
  async mergePr(_repo: Repo, url: string, method: string, headSha?: string | null): Promise<void> {
    if (this.hold) await this.hold;
    if (this.failMerge) throw new Error(this.failMerge);
    this.merged.push({ url, method, ...(headSha ? { headSha } : {}) });
  }
  async retargetPr(_repo: Repo, url: string, base: string): Promise<void> {
    this.retargeted.push({ url, base });
  }
  async prState(_repo: Repo, url: string): Promise<'OPEN' | 'MERGED' | 'CLOSED'> {
    return this.merged.some((m) => m.url === url) ? 'MERGED' : this.state;
  }
  async prInfo(): Promise<PrInfo> {
    this.prInfoCalls++;
    return { title: 'Add feature', body: 'Adds a feature.', author: 'octo', headSha: '', headRef: 'feature', baseRef: 'main', changedLines: this.changedLines, state: 'open', headRepo: this.headRepo };
  }
  changedLines = 2;
  headRepo = 'acme/app';
  failPost = false;
  alreadyPosted: string | null = null;
  prInfoCalls = 0;
  async postReview(_repo: Repo, _slug: string, _n: number, review: PostedReview): Promise<string> {
    if (this.failPost) throw new Error('422 Unprocessable: line must be part of the diff');
    this.posted.push(review);
    return 'https://github.com/acme/app/pull/1#pullrequestreview-1';
  }
  async findReviewWithMarker(_r: Repo, _s: string, _n: number, marker: string): Promise<string | null> {
    this.markers.push(marker);
    return this.alreadyPosted;
  }
  markers: string[] = [];
  async reviewRequests(): Promise<ReviewRequest[]> {
    return this.requests;
  }
  async login(): Promise<string> {
    return this.me;
  }
}

// ---------------------------------------------------------------- setup

let config: OfficeConfig;
let db: Db;
let repo: Repo;
let runner: FakeRunner;
let publisher: FakePublisher;
let pipeline: Pipeline;
let bus: EventBus;
let home: string;

function makePipeline(): Pipeline {
  return new Pipeline({
    db,
    bus,
    config,
    agents: loadAgents(join(appDir, 'agents'), join(appDir, 'skills')),
    runner,
    publisher,
    docs: new TaskDocs(config.tasksDir),
    knowledge: new Knowledge(db, config.knowledgeDir),
    graphs: new Graphs(config.graphsDir),
    slugOf: async () => 'acme/app',
  });
}

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'office-test-')));
  config = loadConfig({ OFFICE_HOME: join(home, 'office') });
  ensureDirs(config);
  const repoPath = join(home, 'app');
  execSync(
    `mkdir -p "${repoPath}/src" && cd "${repoPath}" && git init -q -b main && echo "# app" > README.md && echo "export {};" > src/index.ts && git add . && git -c user.name=t -c user.email=t@t commit -qm init`,
  );
  db = openDb(config.dbPath);
  bus = new EventBus(db);
  repo = await createRepo(db, { name: 'app', path: repoPath, testCmd: 'npm test', gitAuthor: 'Office Test <office@test.dev>' });
  runner = new FakeRunner((id) => pipeline.getTask(id).status);
  publisher = new FakePublisher();
  pipeline = makePipeline();
});

afterEach(async () => {
  await pipeline.shutdown();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await pipeline.tick();
    await pipeline.idle();
  }
}

const statusOf = (t: Task) => pipeline.getTask(t.id).status;
const steps = () => runner.calls.map((c) => c.step);
const planGate = (t: Task) => pipeline.pendingGates(t.id).find((g) => g.kind === 'plan')!;
const mergeGate = (t: Task) => pipeline.pendingGates(t.id).find((g) => g.kind === 'merge')!;
const eventsOf = (t: Task, type: string) => db.select().from(schema.events).where(eq(schema.events.taskId, t.id)).all().filter((e) => e.type === type);

// ---------------------------------------------------------------- tests

describe('pipeline', () => {
  it('runs the full team: I approve the plan, the PR opens by itself, and my OK merges it', async () => {
    const task = pipeline.createTask({ repoId: repo.id, input: 'Add a greeting helper' });
    await settle();
    expect(statusOf(task)).toBe('awaiting_plan_approval');
    expect(pipeline.getTask(task.id).title).toBe('Add greeting');
    expect(pipeline.getTask(task.id).filesInScope).toEqual(['src/**']);

    await pipeline.decideGate(planGate(task).id, 'approve');
    await settle();
    expect(statusOf(task)).toBe('awaiting_merge_approval');
    expect(steps()).toEqual(['intake', 'planning', 'coding', 'reviewing', 'testing']);

    const t = pipeline.getTask(task.id);
    expect(t.branch).toMatch(/^office\/1-/);
    const log = execSync(`git -C "${t.worktreePath}" log --format=%s ${t.baseSha}..HEAD`).toString();
    expect(log).toContain('Add greet helper');
    expect(log).toContain('test: Add greeting');
    expect(publisher.pushed).toEqual([t.branch]);
    expect(publisher.drafts).toEqual([false]);
    expect(t.prUrl).toBe('https://github.com/acme/app/pull/101');
    expect(eventsOf(task, 'pr_opened')).toHaveLength(1);

    // The merge takes exactly the commit the office pushed.
    expect(t.prHeadSha).toBe(execSync(`git -C "${t.worktreePath}" rev-parse HEAD`).toString().trim());
    await pipeline.decideGate(mergeGate(task).id, 'approve');
    expect(publisher.merged).toEqual([{ url: t.prUrl, method: 'squash', headSha: t.prHeadSha }]);
    expect(pipeline.getTask(task.id).worktreePath).toBeNull();
    await settle();
    expect(statusOf(task)).toBe('done');
    expect(steps().at(-1)).toBe('retro');
  });

  it('merges with the repo\'s merge method', async () => {
    db.update(schema.repos).set({ mergeMethod: 'rebase' }).where(eq(schema.repos.id, repo.id)).run();
    runner.queue('intake', () => ({ text: docs.task({ lane: 'solo' }) }));
    const task = pipeline.createTask({ repoId: repo.id, input: 'Add a greeting helper' });
    await settle();
    await pipeline.decideGate(mergeGate(task).id, 'approve');
    expect(publisher.merged[0]!.method).toBe('rebase');
  });

  it('keeps the PR waiting for me, with the reason, when GitHub refuses the merge', async () => {
    runner.queue('intake', () => ({ text: docs.task({ lane: 'solo' }) }));
    const task = pipeline.createTask({ repoId: repo.id, input: 'Add a greeting helper' });
    await settle();
    publisher.failMerge = 'Required status check "ci" is failing';
    await pipeline.decideGate(mergeGate(task).id, 'approve');
    const t = pipeline.getTask(task.id);
    expect(t.status).toBe('awaiting_merge_approval');
    expect(t.statusNote).toContain('Required status check');
    expect(mergeGate(task)).toBeTruthy();
    publisher.failMerge = null;
    await pipeline.decideGate(mergeGate(task).id, 'approve');
    expect(publisher.merged).toHaveLength(1);
  });

  it('sends the PR back for changes with my comment; the fixes update the same PR', async () => {
    runner.queue('intake', () => ({ text: docs.task({ lane: 'solo' }) }));
    const task = pipeline.createTask({ repoId: repo.id, input: 'Add a greeting helper' });
    await settle();
    const url = pipeline.getTask(task.id).prUrl;
    await pipeline.decideGate(mergeGate(task).id, 'reject', 'Call it greet, not hello');
    await settle();
    const fix = runner.calls.at(-1)!;
    expect(fix.step).toBe('coding');
    // The same session continues, with my comment as the new message.
    expect(fix.resume?.sessionId).toMatch(/^session-/);
    expect(fix.resume?.prompt).toContain('Call it greet, not hello');
    expect(fix.resume?.prompt).toContain('status: done');
    expect(statusOf(task)).toBe('awaiting_merge_approval');
    expect(pipeline.getTask(task.id).prUrl).toBe(url);
    expect(eventsOf(task, 'pr_opened')).toHaveLength(1);
    expect(eventsOf(task, 'pr_updated')).toHaveLength(1);
    expect(mergeGate(task)).toBeTruthy();
  });

  it('opens the PR when the tester adds no tests for a change with no behaviour', async () => {
    runner.queue('testing', () => ({ text: '---\nresult: pass\ntests_added: 0\n---\n## Tests added\n- none: README wording only\n\n## Suite\nnpm test: 3 passed' }));
    const task = pipeline.createTask({ repoId: repo.id, input: 'Fix a typo in the README' });
    await settle();
    await pipeline.decideGate(planGate(task).id, 'approve');
    await settle();
    expect(statusOf(task)).toBe('awaiting_merge_approval');
    const t = pipeline.getTask(task.id);
    const log = execSync(`git -C "${t.worktreePath}" log --format=%s ${t.baseSha}..HEAD`).toString();
    expect(log).not.toContain('test:');
  });

  describe('lanes', () => {
    const intakeAs = (o: Parameters<typeof docs.task>[0]) => runner.queue('intake', () => ({ text: docs.task(o) }));
    const laneOf = (t: Task) => pipeline.getTask(t.id).lane;
    const rolesOf = (t: Task) => db.select().from(schema.runs).where(eq(schema.runs.taskId, t.id)).all().map((r) => [r.step, r.role]);

    it('has the all-rounder build a solo task alone, then opens the PR for me', async () => {
      intakeAs({ lane: 'solo', size: 'M' });
      const task = pipeline.createTask({ repoId: repo.id, input: 'Add a greeting helper' });
      await settle();
      expect(steps()).toEqual(['intake', 'coding']);
      expect(rolesOf(task)).toEqual([['intake', 'manager'], ['coding', 'all-rounder']]);
      expect(laneOf(task)).toBe('solo');
      const prompt = runner.calls[1]!.prompt;
      expect(prompt).toContain('You have this task to yourself');
      expect(prompt).toContain('### task.md');
      expect(runner.calls[1]!.model).toBe('claude-opus-5-5');
      expect(statusOf(task)).toBe('awaiting_merge_approval');
      expect(pipeline.pendingGates(task.id).map((g) => g.kind)).toEqual(['merge']);
      expect(publisher.pushed).toHaveLength(1);

      await pipeline.decideGate(mergeGate(task).id, 'approve');
      await settle();
      expect(statusOf(task)).toBe('done');
      expect(steps().at(-1)).toBe('retro');
    });

    it('skips the debugger and researcher on a solo task: the all-rounder investigates itself', async () => {
      intakeAs({ lane: 'solo', debugger: true });
      pipeline.createTask({ repoId: repo.id, input: 'The greeting is wrong' });
      await settle();
      expect(steps()).toEqual(['intake', 'coding']);
    });

    it('gives a big solo diff one review, and no separate tester', async () => {
      intakeAs({ lane: 'solo' });
      runner.queue('coding', (req) => {
        writeFileSync(join(req.cwd, 'src', 'big.ts'), Array.from({ length: 250 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n');
        return { text: docs.changes };
      });
      const task = pipeline.createTask({ repoId: repo.id, input: 'Add constants' });
      await settle();
      expect(steps()).toEqual(['intake', 'coding', 'reviewing']);
      expect(laneOf(task)).toBe('solo');
      expect(eventsOf(task, 'review_added')[0]!.payload.reason).toContain('250 lines');
      expect(runner.calls[2]!.prompt).toContain('there is no separate plan');
      expect(statusOf(task)).toBe('awaiting_merge_approval');
    });

    it('sends review findings back into the all-rounder\'s own session', async () => {
      intakeAs({ lane: 'solo' });
      const big: Script = (req) => {
        writeFileSync(join(req.cwd, 'src', 'big.ts'), Array.from({ length: 250 }, (_, i) => `export const v${i} = ${i} + ${Math.random()};`).join('\n') + '\n');
        return { text: docs.changes };
      };
      runner.queue('coding', big, big);
      runner.queue('reviewing', () => ({ text: docs.reviewFail }));
      const task = pipeline.createTask({ repoId: repo.id, input: 'Add constants' });
      await settle();
      expect(steps()).toEqual(['intake', 'coding', 'reviewing', 'coding', 'reviewing']);
      const [first, fix] = runner.calls.filter((c) => c.step === 'coding');
      expect(first!.resume).toBeUndefined();
      const firstRun = db.select().from(schema.runs).where(eq(schema.runs.step, 'coding')).get()!;
      expect(fix!.resume).toEqual({
        sessionId: firstRun.sessionId,
        prompt: expect.stringContaining('[blocking] src/greet.ts:1'),
        // What that session already spent is recorded; the resumed run counts only its own tokens.
        usageSoFar: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, thinking: 0 },
      });
      expect(statusOf(task)).toBe('awaiting_merge_approval');
    });

    it('hands a solo task to the full team when the all-rounder raises a blocker', async () => {
      intakeAs({ lane: 'solo' });
      runner.queue('coding', () => ({ text: docs.blocked }));
      const task = pipeline.createTask({ repoId: repo.id, input: 'Add a greeting helper' });
      await settle();
      expect(statusOf(task)).toBe('awaiting_plan_approval');
      expect(laneOf(task)).toBe('standard');
      expect(runner.calls.at(-1)!.prompt).toContain('started this task alone');
      await pipeline.decideGate(planGate(task).id, 'approve');
      await settle();
      // The coder starts fresh from the plan: the all-rounder's session isn't continued.
      const coder = runner.calls.filter((c) => c.step === 'coding').at(-1)!;
      expect(coder.role).toBe('coder');
      expect(coder.resume).toBeUndefined();
    });

    it('runs the lanes from before solo (trivial, small) as solo', async () => {
      intakeAs({ lane: 'small' });
      const task = pipeline.createTask({ repoId: repo.id, input: 'Add a greeting helper' });
      await settle();
      expect(laneOf(task)).toBe('solo');
      expect(rolesOf(task).at(-1)).toEqual(['coding', 'all-rounder']);
    });

    it('keeps size L, or a task without a lane, on the full team', async () => {
      intakeAs({ lane: 'solo', size: 'L' });
      const a = pipeline.createTask({ repoId: repo.id, input: 'a' });
      const b = pipeline.createTask({ repoId: repo.id, input: 'b' });
      await settle();
      expect([statusOf(a), statusOf(b)]).toEqual(['awaiting_plan_approval', 'awaiting_plan_approval']);
      expect([laneOf(a), laneOf(b)]).toEqual(['standard', 'standard']);
    });

    it('follows my lane pick from the mission panel', async () => {
      intakeAs({ lane: 'solo' });
      const team = pipeline.createTask({ repoId: repo.id, input: 'a', lane: 'standard' });
      await settle();
      expect(laneOf(team)).toBe('standard');
      expect(statusOf(team)).toBe('awaiting_plan_approval');

      intakeAs({ lane: 'standard', size: 'L', epic: true });
      const solo = pipeline.createTask({ repoId: repo.id, input: 'b', lane: 'solo' });
      await settle();
      expect(laneOf(solo)).toBe('solo');
      expect(steps()).not.toContain('splitting');
      expect(statusOf(solo)).toBe('awaiting_merge_approval');
    });

    it('hands the coding step of a frontend task on the full team to the UI coder', async () => {
      intakeAs({ lane: 'standard', frontend: true });
      const task = pipeline.createTask({ repoId: repo.id, input: 'Restyle the settings page' });
      await settle();
      await pipeline.decideGate(planGate(task).id, 'approve');
      await settle();
      expect(pipeline.getTask(task.id).frontend).toBe(true);
      expect(rolesOf(task).find(([step]) => step === 'coding')).toEqual(['coding', 'ui-coder']);
    });
  });

  describe('models by size', () => {
    const OPUS = 'claude-opus-5-5'; // the built-in architect and reviewer
    const modelOf = (step: string) => runner.calls.find((c) => c.step === step)!;

    it('reviews an S task on Sonnet at medium effort, but always plans on Opus', async () => {
      const task = pipeline.createTask({ repoId: repo.id, input: 'Add a greeting helper' }); // intake says size S
      await settle();
      await pipeline.decideGate(planGate(task).id, 'approve');
      await settle();
      expect(modelOf('planning')).toMatchObject({ model: OPUS, effort: 'high' });
      expect(modelOf('reviewing')).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' });
      expect(modelOf('coding').model).toBe('claude-sonnet-5-5');
      const planRun = db.select().from(schema.runs).where(eq(schema.runs.step, 'planning')).get()!;
      expect(planRun.model).toBe(OPUS);
    });

    it('keeps Opus for reviews of bigger tasks, and of S tasks when the setting is off', async () => {
      runner.queue('intake', () => ({ text: docs.task({ size: 'M' }) }));
      const a = pipeline.createTask({ repoId: repo.id, input: 'a' });
      await settle();
      await pipeline.decideGate(planGate(a).id, 'approve');
      await settle();
      expect(modelOf('reviewing').model).toBe(OPUS);

      setSetting(db, 'sonnetForSmall', false);
      runner.calls = [];
      const b = pipeline.createTask({ repoId: repo.id, input: 'b' });
      await settle();
      await pipeline.decideGate(planGate(b).id, 'approve');
      await settle();
      expect(modelOf('reviewing').model).toBe(OPUS);
    });
  });

  describe('epics', () => {
    const breakdown = (n = 2) =>
      `---\nmilestones: ${n}\n---\n## Overview\nIn order.\n\n## Milestones\n${Array.from({ length: n }, (_, i) => `### ${i + 1}. Part ${i + 1}\nBuild part ${i + 1}.\n- it works`).join('\n\n')}\n\n## Not in these milestones\n- nothing`;
    const startEpic = (n = 2) => {
      runner.queue('intake', () => ({ text: docs.task({ size: 'L', epic: true }) }));
      runner.queue('splitting', () => ({ text: breakdown(n) }));
      return pipeline.createTask({ repoId: repo.id, input: 'Build a chat app' });
    };
    const gateOf = (t: Task, kind: string) => pipeline.pendingGates(t.id).find((g) => g.kind === kind)!;
    const children = (epic: Task) => db.select().from(schema.tasks).where(eq(schema.tasks.parentId, epic.id)).all();

    it('splits a huge request into milestone tasks that run in order, each on the previous branch', async () => {
      const epic = startEpic();
      await settle();
      expect(statusOf(epic)).toBe('awaiting_breakdown_approval');
      expect(steps()).toEqual(['intake', 'splitting']);

      await pipeline.decideGate(gateOf(epic, 'breakdown').id, 'approve');
      const [a, b] = children(epic);
      expect(statusOf(epic)).toBe('done');
      expect(pipeline.getTask(epic.id).statusNote).toBe(`Split into 2 milestones: #${a!.id}, #${b!.id}.`);
      expect([a!.title, b!.title]).toEqual(['Part 1', 'Part 2']);
      expect(a!.input).toContain('Milestone 1 of 2 of #' + epic.id);
      expect(b!.dependsOn).toBe(a!.id);
      expect(a!.refRepos).toEqual(pipeline.getTask(epic.id).refRepos);
      expect(b!.statusNote).toContain('Waits for milestone 1');

      await settle();
      expect(statusOf(a!)).toBe('awaiting_plan_approval');
      expect(statusOf(b!)).toBe('queued'); // waits for a's PR

      await pipeline.decideGate(planGate(a!).id, 'approve');
      await settle();
      expect(statusOf(a!)).toBe('awaiting_merge_approval');
      const started = pipeline.getTask(b!.id);
      expect(started.status).toBe('awaiting_plan_approval');
      expect(started.baseBranch).toBe(pipeline.getTask(a!.id).branch);
      expect(started.statusNote).toBeNull();

      await pipeline.decideGate(planGate(b!).id, 'approve');
      await settle();
      expect(publisher.bases.at(-1)).toBe(pipeline.getTask(a!.id).branch); // a stacked PR

      // b can't merge into a's branch before a merges; once a has, b's PR moves to main first.
      await pipeline.decideGate(mergeGate(b!).id, 'approve');
      expect(statusOf(b!)).toBe('awaiting_merge_approval');
      expect(pipeline.getTask(b!.id).statusNote).toContain(`merge #${a!.id} first`);
      expect(publisher.merged).toEqual([]);
      await pipeline.decideGate(mergeGate(a!).id, 'approve');
      await pipeline.decideGate(mergeGate(b!).id, 'approve');
      expect(publisher.retargeted).toEqual([{ url: pipeline.getTask(b!.id).prUrl, base: 'main' }]);
      expect(publisher.merged).toHaveLength(2);
      expect(pipeline.getTask(b!.id).baseBranch).toBeNull();
    });

    it('sends the milestones back to the architect with my comment', async () => {
      const epic = startEpic();
      await settle();
      runner.queue('splitting', () => ({ text: breakdown(3) }));
      await pipeline.decideGate(gateOf(epic, 'breakdown').id, 'reject', 'Do auth first');
      await settle();
      expect(statusOf(epic)).toBe('awaiting_breakdown_approval');
      expect(runner.calls.filter((c) => c.step === 'splitting').at(-1)!.prompt).toContain('Do auth first');
      expect(() => pipeline.replanNow(epic.id, 'x')).toThrow(/epic/);
    });

    it('blocks a milestone whose predecessor was discarded; resuming starts it without it', async () => {
      const epic = startEpic();
      await settle();
      await pipeline.decideGate(gateOf(epic, 'breakdown').id, 'approve');
      const [a, b] = children(epic);
      await pipeline.action(a!.id, 'discard');
      await settle();
      expect(statusOf(b!)).toBe('blocked');
      expect(pipeline.getTask(b!.id).statusNote).toContain(`#${a!.id} it builds on was discarded`);
      await pipeline.action(b!.id, 'resume');
      await settle();
      expect(statusOf(b!)).toBe('awaiting_plan_approval');
      expect(pipeline.getTask(b!.id).baseBranch).toBeNull();
    });

    it('only treats size L requests as epics', async () => {
      runner.queue('intake', () => ({ text: docs.task({ size: 'M', epic: true }) }));
      const t = pipeline.createTask({ repoId: repo.id, input: 'Medium thing' });
      await settle();
      expect(statusOf(t)).toBe('awaiting_plan_approval');
      expect(steps()).not.toContain('splitting');
    });
  });

  describe('reference repos', () => {
    const otherRepo = async (name: string) => {
      const path = join(home, name);
      execSync(`mkdir -p "${path}" && cd "${path}" && git init -q -b main && echo "export const port = 1;" > lib.ts && git add . && git -c user.name=t -c user.email=t@t commit -qm init`);
      return createRepo(db, { name, path });
    };

    it('lets every step read the reference repos, read-only, and tells the agents where they are', async () => {
      const lib = await otherRepo('lib');
      const task = pipeline.createTask({ repoId: repo.id, input: 'Port the port helper from lib', refRepos: [lib.id, repo.id, lib.id] });
      expect(pipeline.getTask(task.id).refRepos).toEqual([lib.id]); // its own repo and repeats dropped
      await settle();
      for (const step of ['intake', 'planning']) {
        const call = runner.calls.find((c) => c.step === step)!;
        expect(call.readRoots).toContain(lib.path);
        expect(call.prompt).toContain('## Reference repos (read-only)');
        expect(call.prompt).toContain(`- lib: ${lib.path}`);
      }
    });

    it('refuses unknown repos and more than three', async () => {
      expect(() => pipeline.createTask({ repoId: repo.id, input: 'x', refRepos: [999] })).toThrow();
      const ids: number[] = [];
      for (const n of ['a', 'b', 'c', 'd']) ids.push((await otherRepo(n)).id);
      expect(() => pipeline.createTask({ repoId: repo.id, input: 'x', refRepos: ids })).toThrow(/at most 3/);
    });

    it('passes no extra read roots without references or attachments', async () => {
      pipeline.createTask({ repoId: repo.id, input: 'Plain' });
      await settle();
      expect(runner.calls[0]!.readRoots).toBeUndefined();
    });
  });

  it('leaves no pending gate behind when a task is discarded or marked done', async () => {
    const a = pipeline.createTask({ repoId: repo.id, input: 'a' });
    await settle();
    expect(pipeline.pendingGates(a.id)).toHaveLength(1);
    await pipeline.action(a.id, 'discard');
    expect(pipeline.pendingGates(a.id)).toHaveLength(0);

    const b = pipeline.createTask({ repoId: repo.id, input: 'b' });
    await settle();
    await pipeline.decideGate(planGate(b).id, 'approve');
    await settle();
    expect(mergeGate(b)).toBeTruthy();
    await pipeline.action(b.id, 'done');
    expect(pipeline.pendingGates(b.id)).toHaveLength(0);
    await settle();
    expect(statusOf(b)).toBe('done');
  });

  it('steers a running agent live, or saves the note for the next step', async () => {
    const steered: string[] = [];
    runner.steer = (_runId: number, text: string) => (steered.push(text), true);
    runner.queue('planning', hang);
    const task = pipeline.createTask({ repoId: repo.id, input: 'x' });
    await until(() => statusOf(task) === 'planning' && pipeline.isRunning(task.id));
    expect(pipeline.steer(task.id, 'use the existing helper')).toBe('live');
    expect(steered[0]).toContain('use the existing helper');
    await pipeline.action(task.id, 'stop');
    await settle();

    runner.steer = () => false;
    expect(pipeline.steer(task.id, 'keep it small')).toBe('next_step');
    await pipeline.action(task.id, 'resume');
    await settle();
    expect(runner.calls.at(-1)!.prompt).toContain('keep it small');
  });

  it('re-plans on request, stopping the running step, without counting toward the limit', async () => {
    runner.queue('coding', hang);
    const task = pipeline.createTask({ repoId: repo.id, input: 'x' });
    await settle();
    await pipeline.decideGate(planGate(task).id, 'approve');
    await until(() => statusOf(task) === 'coding' && pipeline.isRunning(task.id));
    pipeline.replanNow(task.id, 'split it into two steps');
    await settle();
    expect(statusOf(task)).toBe('awaiting_plan_approval');
    expect(runner.calls.at(-1)!.prompt).toContain('split it into two steps');
    expect(pipeline.getTask(task.id).replanCount).toBe(0);
  });

  it('proposes the knowledge note from the retrospective and gives approved notes to every agent', async () => {
    runner.queue('retro', () => ({ text: '---\n---\n- **Went well:** a\n- **Went wrong:** b\n- **Knowledge-file edit:** Always run codegen first.' }));
    const task = pipeline.createTask({ repoId: repo.id, input: 'x' });
    await settle();
    await pipeline.decideGate(planGate(task).id, 'approve');
    await settle();
    await pipeline.decideGate(mergeGate(task).id, 'approve');
    await settle();
    const k = new Knowledge(db, config.knowledgeDir);
    const [p] = k.proposals('pending', repo.id);
    expect(p!.text).toBe('Always run codegen first.');
    k.decide(p!.id, 'accept');
    pipeline.createTask({ repoId: repo.id, input: 'next' });
    await settle();
    expect(runner.calls.at(-1)!.prompt).toContain('## Repo knowledge');
    expect(runner.calls.at(-1)!.prompt).toContain('Always run codegen first.');
  });

  it('starts no new steps near the usage limit', async () => {
    setSetting(db, 'rateLimit', { fiveHour: 0.95, fiveHourResetsAt: Math.floor(Date.now() / 1000) + 3600, at: Date.now() });
    const task = pipeline.createTask({ repoId: repo.id, input: 'x' });
    await settle();
    expect(statusOf(task)).toBe('queued');
    expect(runner.calls).toHaveLength(0);
    setSetting(db, 'usagePauseAt', 1);
    await settle();
    expect(statusOf(task)).toBe('awaiting_plan_approval');
  });

  it('gives the architect the code graph when the repo uses it, and records that on the run', async () => {
    const { updateRepo } = await import('../server/src/repos.js');
    await updateRepo(db, repo.id, { ...repo, graphify: true });
    const graphs = new Graphs(config.graphsDir);
    graphs.mcpFor = (r, role) => (r.graphify && role === 'architect' ? { graphify: { type: 'stdio', command: '/abs/graphify-mcp', args: ['/g.json'] } } : undefined);
    graphs.build = async () => {};
    pipeline = new Pipeline({ ...(pipeline as unknown as { deps: ConstructorParameters<typeof Pipeline>[0] }).deps, graphs });
    let mcp: unknown;
    runner.queue('planning', (req) => ((mcp = req.mcpServers), { text: docs.plan }));
    const task = pipeline.createTask({ repoId: repo.id, input: 'x' });
    await settle();
    expect(mcp).toEqual({ graphify: { type: 'stdio', command: '/abs/graphify-mcp', args: ['/g.json'] } });
    expect(runner.calls[1]!.prompt).toContain('## Code graph');
    expect(runner.calls[0]!.prompt).not.toContain('## Code graph'); // the manager doesn't get it
    const runs = db.select().from(schema.runs).where(eq(schema.runs.taskId, task.id)).all();
    expect(runs.map((r) => [r.role, r.graphify])).toEqual([['manager', false], ['architect', true]]);
    expect(pipeline.graphTokenStats(repo.id).withGraph.runs).toBe(1);
  });

  it('records token usage per run', async () => {
    const task = pipeline.createTask({ repoId: repo.id, input: 'x' });
    await settle();
    expect(pipeline.tokensUsed(task.id)).toBe(300); // intake + planning, 150 each
  });

  it('runs the debugger first for bugs flagged at intake', async () => {
    runner.queue('intake', () => ({ text: docs.task({ debugger: true }) }));
    const task = pipeline.createTask({ repoId: repo.id, input: 'Fix crash' });
    await settle();
    expect(steps()).toEqual(['intake', 'debugging', 'planning']);
    expect(runner.calls[2]!.prompt).toContain('### diagnosis.md');
    expect(statusOf(task)).toBe('awaiting_plan_approval');
  });

  it('sends a rejected plan back to the architect with my comment', async () => {
    const task = pipeline.createTask({ repoId: repo.id, input: 'x' });
    await settle();
    await expect(pipeline.decideGate(planGate(task).id, 'reject')).rejects.toThrow(/Say what to change/);
    await pipeline.decideGate(planGate(task).id, 'reject', 'Use the existing formatter');
    await settle();
    expect(steps()).toEqual(['intake', 'planning', 'planning']);
    expect(runner.calls[2]!.prompt).toContain('Use the existing formatter');
    expect(runner.calls[2]!.prompt).toContain('### Rejected plan');
    expect(statusOf(task)).toBe('awaiting_plan_approval');
  });

  it('routes a coder blocker back to the architect', async () => {
    runner.queue('coding', () => ({ text: docs.blocked }));
    const task = pipeline.createTask({ repoId: repo.id, input: 'x' });
    await settle();
    await pipeline.decideGate(planGate(task).id, 'approve');
    await settle();
    expect(steps()).toEqual(['intake', 'planning', 'coding', 'planning']);
    expect(runner.calls[3]!.prompt).toContain('does not exist');
    expect(pipeline.getTask(task.id).replanCount).toBe(1);
  });

  it('loops review failures to the coder twice, then re-plans', async () => {
    runner.queue('reviewing', () => ({ text: docs.reviewFail }), () => ({ text: docs.reviewFail }), () => ({ text: docs.reviewFail }));
    const task = pipeline.createTask({ repoId: repo.id, input: 'x' });
    await settle();
    await pipeline.decideGate(planGate(task).id, 'approve');
    await settle();
    expect(steps()).toEqual(['intake', 'planning', 'coding', 'reviewing', 'coding', 'reviewing', 'coding', 'reviewing', 'planning']);
    expect(runner.calls[4]!.prompt).toContain('[blocking] src/greet.ts:1');
    const t = pipeline.getTask(task.id);
    expect(t.replanCount).toBe(1);
    expect(t.loopCount).toBe(0);
    expect(t.status).toBe('awaiting_plan_approval');
  });

  it('blocks for me after two re-plans', async () => {
    for (let i = 0; i < 3; i++) runner.queue('coding', () => ({ text: docs.blocked }));
    const task = pipeline.createTask({ repoId: repo.id, input: 'x' });
    await settle();
    for (let i = 0; i < 3; i++) {
      await pipeline.decideGate(planGate(task).id, 'approve');
      await settle();
    }
    expect(statusOf(task)).toBe('blocked');
    expect(pipeline.getTask(task.id).resumeStatus).toBe('planning');
  });

  it('counts test failures and loops them like review failures', async () => {
    runner.queue('testing', () => ({ text: docs.testFail }));
    const task = pipeline.createTask({ repoId: repo.id, input: 'x' });
    await settle();
    await pipeline.decideGate(planGate(task).id, 'approve');
    await settle();
    expect(steps().slice(2)).toEqual(['coding', 'reviewing', 'testing', 'coding', 'reviewing', 'testing']);
    expect(pipeline.getTask(task.id).testFailures).toBe(1);
    expect(statusOf(task)).toBe('awaiting_merge_approval');
  });

  it('never auto-approves the plan', async () => {
    const task = pipeline.createTask({ repoId: repo.id, input: 'x' });
    await settle();
    expect(statusOf(task)).toBe('awaiting_plan_approval');
  });

  it('stops a running step, keeps the worktree, and resumes it', async () => {
    runner.queue('planning', hang);
    const task = pipeline.createTask({ repoId: repo.id, input: 'x' });
    await until(() => statusOf(task) === 'planning' && pipeline.isRunning(task.id));
    await pipeline.action(task.id, 'stop');
    await settle();
    const stopped = pipeline.getTask(task.id);
    expect(stopped.status).toBe('stopped');
    expect(stopped.resumeStatus).toBe('planning');
    expect(stopped.worktreePath).toBeTruthy();

    await pipeline.action(task.id, 'resume');
    await settle();
    expect(statusOf(task)).toBe('awaiting_plan_approval');
  });

  it('parks interrupted steps on restart instead of re-running them', async () => {
    runner.queue('coding', hang);
    const task = pipeline.createTask({ repoId: repo.id, input: 'x' });
    await settle();
    await pipeline.decideGate(planGate(task).id, 'approve');
    await until(() => pipeline.isRunning(task.id));

    // Simulate a crash: a fresh process sees the task mid-step.
    const crashed = pipeline;
    const restarted = makePipeline();
    restarted.recover();
    const t = restarted.getTask(task.id);
    expect(t.status).toBe('paused');
    expect(t.resumeStatus).toBe('coding');
    await crashed.shutdown();
    expect(restarted.getTask(task.id).status).toBe('paused');
    pipeline = restarted;
  });

  it('runs at most two tasks at once; a third waits in the queue', async () => {
    runner.queue('intake', hang, hang, hang);
    const tasks = [1, 2, 3].map((i) => pipeline.createTask({ repoId: repo.id, input: `task ${i}` }));
    await until(() => runner.active === 2);
    await new Promise((r) => setTimeout(r, 100));
    expect(runner.maxActive).toBe(2);
    expect(tasks.map(statusOf)).toEqual(['intake', 'intake', 'queued']);
    for (const t of tasks) await pipeline.action(t.id, 'discard');
  });

  it('pauses on an off-list command until I decide, and remembers "always"', async () => {
    runner.queue('intake', async (req) => {
      const answer = await req.askPermission('curl --version', ['curl --version'], 'not on the allow-list');
      return { text: answer === 'allow_always' ? docs.task() : '' };
    });
    const task = pipeline.createTask({ repoId: repo.id, input: 'x' });
    await until(() => pipeline.pendingGates(task.id).length > 0);
    const gate = pipeline.pendingGates(task.id)[0]!;
    expect(gate.kind).toBe('command');
    expect(gate.subject).toBe('curl --version');

    await pipeline.decideGate(gate.id, 'allow_always');
    await settle();
    expect(getRepo(db, repo.id).allowlist).toContain('curl --version');
    expect(statusOf(task)).toBe('awaiting_plan_approval');
  });

  it('auto-allows routine commands when turned on, but still asks for crucial ones', async () => {
    setSetting(db, 'autoAllowCommands', true);
    const answers: string[] = [];
    runner.queue('intake', async (req) => {
      answers.push(await req.askPermission('cargo build', ['cargo build'], 'not on the allow-list'));
      answers.push(await req.askPermission('firebase deploy', ['firebase deploy'], 'not on the allow-list'));
      return { text: docs.task() };
    });
    const task = pipeline.createTask({ repoId: repo.id, input: 'x' });
    await until(() => pipeline.pendingGates(task.id).length > 0);
    expect(answers).toEqual(['allow_once']);
    const gate = pipeline.pendingGates(task.id)[0]!;
    expect(gate.subject).toBe('firebase deploy');
    const auto = db.select().from(schema.gates).all().find((g) => g.subject === 'cargo build')!;
    expect(auto).toMatchObject({ auto: true, status: 'approved' });

    await pipeline.decideGate(gate.id, 'deny');
    await settle();
    expect(answers).toEqual(['allow_once', 'deny']);
    expect(getRepo(db, repo.id).allowlist).not.toContain('cargo build');
  });

  it('pauses on a usage limit and resumes after the reset time', async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    runner.queue('intake', () => ({ status: 'rate_limited', resetsAt, text: '' }));
    const task = pipeline.createTask({ repoId: repo.id, input: 'x' });
    await settle();
    const t = pipeline.getTask(task.id);
    expect(t.status).toBe('paused');
    expect(t.resumeAt).toBe(resetsAt * 1000);
    expect(t.resumeStatus).toBe('intake');
  });

  it('blocks a failed step so I can resume it', async () => {
    runner.queue('planning', () => ({ status: 'failed', error: 'boom', text: '' }));
    const task = pipeline.createTask({ repoId: repo.id, input: 'x' });
    await settle();
    expect(statusOf(task)).toBe('blocked');
    await pipeline.action(task.id, 'resume');
    await settle();
    expect(statusOf(task)).toBe('awaiting_plan_approval');
  });

  it('alerts when the coder changes files outside the plan', async () => {
    runner.queue('coding', (req) => {
      writeFileSync(join(req.cwd, 'README.md'), 'changed\n');
      return { text: docs.changes };
    });
    const task = pipeline.createTask({ repoId: repo.id, input: 'x' });
    await settle();
    await pipeline.decideGate(planGate(task).id, 'approve');
    await settle();
    const alerts: string[] = [];
    const events = db.query.events.findMany().sync();
    for (const e of events) if (e.type === 'alert') alerts.push(String(e.payload.kind));
    expect(alerts).toContain('scope');
  });

  it('runs the repo setup command in each new worktree', async () => {
    const { updateRepo } = await import('../server/src/repos.js');
    await updateRepo(db, repo.id, { ...repo, setupCmd: 'echo "$REPO_PATH" > .setup-ran' });
    const task = pipeline.createTask({ repoId: repo.id, input: 'x' });
    await settle();
    const wt = pipeline.getTask(task.id).worktreePath!;
    expect(execSync(`cat "${wt}/.setup-ran"`).toString().trim()).toBe(repo.path);
  });

  it('never commits what the setup command created (e.g. a symlinked node_modules)', async () => {
    const { updateRepo } = await import('../server/src/repos.js');
    await updateRepo(db, repo.id, { ...repo, setupCmd: 'mkdir -p /tmp/office-nm && ln -s /tmp/office-nm node_modules' });
    const task = pipeline.createTask({ repoId: repo.id, input: 'x' });
    await settle();
    await pipeline.decideGate(planGate(task).id, 'approve');
    await settle();
    const t = pipeline.getTask(task.id);
    const files = execSync(`git -C "${t.worktreePath}" diff --name-only ${t.baseSha} HEAD`).toString();
    expect(files).toContain('src/greet.ts');
    expect(files).not.toContain('node_modules');
  });

  it('notices a PR I merged on GitHub myself: no gate left, retro, worktree removed', async () => {
    const task = pipeline.createTask({ repoId: repo.id, input: 'x' });
    await settle();
    await pipeline.decideGate(planGate(task).id, 'approve');
    await settle();
    expect(mergeGate(task)).toBeTruthy();
    publisher.state = 'MERGED';
    await pipeline.sweep();
    await settle();
    const t = pipeline.getTask(task.id);
    expect(t.status).toBe('done');
    expect(t.worktreePath).toBeNull();
    expect(pipeline.pendingGates(task.id)).toEqual([]);
    expect(publisher.merged).toEqual([]);
    expect(eventsOf(task, 'pr_merged')[0]!.payload.by).toBe('github');
  });
});

// ---------------------------------------------------------------- open PRs and merging

describe('open PRs and merging', () => {
  const solo = () => runner.queue('intake', () => ({ text: docs.task({ lane: 'solo' }) }));
  const atMergeGate = async () => {
    solo();
    const task = pipeline.createTask({ repoId: repo.id, input: 'Add a greeting helper' });
    await settle();
    expect(statusOf(task)).toBe('awaiting_merge_approval');
    return task;
  };
  const release = () => {
    let open!: () => void;
    publisher.hold = new Promise<void>((r) => (open = r));
    return () => {
      publisher.hold = null;
      open();
    };
  };

  it('keeps a task discarded during its push discarded: no merge gate comes back', async () => {
    solo();
    const go = release();
    const task = pipeline.createTask({ repoId: repo.id, input: 'Add a greeting helper' });
    await until(() => statusOf(task) === 'pushing');
    await pipeline.action(task.id, 'discard');
    go();
    await settle();
    expect(statusOf(task)).toBe('discarded');
    expect(pipeline.pendingGates(task.id)).toEqual([]);
  });

  it('keeps a task stopped during its merge stopped, and resuming asks me again instead of merging', async () => {
    const task = await atMergeGate();
    const go = release();
    const merging = pipeline.decideGate(mergeGate(task).id, 'approve');
    await until(() => statusOf(task) === 'merging');
    await pipeline.action(task.id, 'stop');
    publisher.failMerge = 'connection reset';
    go();
    await merging;
    expect(statusOf(task)).toBe('stopped');
    expect(pipeline.pendingGates(task.id)).toEqual([]);
    publisher.failMerge = null;

    await pipeline.action(task.id, 'resume');
    expect(statusOf(task)).toBe('awaiting_merge_approval');
    expect(mergeGate(task)).toBeTruthy();
    expect(publisher.merged).toEqual([]);
  });

  it('parks a merge cut off by a restart; resuming checks GitHub before asking me again', async () => {
    const task = await atMergeGate();
    db.update(schema.tasks).set({ status: 'merging' }).where(eq(schema.tasks.id, task.id)).run();
    pipeline.recover();
    expect(pipeline.getTask(task.id)).toMatchObject({ status: 'paused', resumeStatus: 'merging' });
    publisher.state = 'MERGED'; // the merge went through before the restart
    await pipeline.action(task.id, 'resume');
    await settle();
    expect(statusOf(task)).toBe('done');
    expect(publisher.merged).toEqual([]);
  });

  it('retries a failed push on resume, then opens the PR', async () => {
    publisher.failPush = 'Could not resolve host: github.com';
    solo();
    const task = pipeline.createTask({ repoId: repo.id, input: 'Add a greeting helper' });
    await settle();
    expect(pipeline.getTask(task.id)).toMatchObject({ status: 'blocked', resumeStatus: 'pushing' });
    publisher.failPush = null;
    await pipeline.action(task.id, 'resume');
    expect(statusOf(task)).toBe('awaiting_merge_approval');
    expect(mergeGate(task)).toBeTruthy();
  });

  it('opens the PR and a merge gate when I approve a push gate left from before', async () => {
    const task = await atMergeGate();
    // As an older office left it: committed work waiting at a push gate, no PR yet.
    db.update(schema.gates).set({ status: 'cancelled' }).where(eq(schema.gates.taskId, task.id)).run();
    db.update(schema.tasks).set({ status: 'awaiting_push_approval', prUrl: null, prHeadSha: null }).where(eq(schema.tasks.id, task.id)).run();
    const push = db.insert(schema.gates).values({ taskId: task.id, kind: 'push' }).returning().get();
    await pipeline.decideGate(push.id, 'approve');
    expect(statusOf(task)).toBe('awaiting_merge_approval');
    expect(mergeGate(task)).toBeTruthy();
  });

  it('drops the merge gate when the PR is closed on GitHub; reopening and resuming brings it back', async () => {
    const task = await atMergeGate();
    publisher.state = 'CLOSED';
    await pipeline.sweep();
    expect(pipeline.getTask(task.id)).toMatchObject({ status: 'blocked', resumeStatus: 'pushing' });
    expect(pipeline.pendingGates(task.id)).toEqual([]);
    publisher.state = 'OPEN';
    await pipeline.action(task.id, 'resume');
    expect(mergeGate(task)).toBeTruthy();
  });

  it('keeps my "changes needed" comment when the fix run fails, and gives it to the retry', async () => {
    const task = await atMergeGate();
    // The resumed session itself fails (it started, so it has the same session id).
    runner.queue('coding', (req) => ({ status: 'failed', error: 'prompt is too long', sessionId: req.resume?.sessionId }));
    await pipeline.decideGate(mergeGate(task).id, 'reject', 'Call it greet, not hello');
    await settle();
    expect(pipeline.getTask(task.id)).toMatchObject({ status: 'blocked', feedback: expect.stringContaining('Call it greet') });
    await pipeline.action(task.id, 'resume');
    await settle();
    // The retry starts fresh (that session would fail again), with my comment in its prompt.
    const retry = runner.calls.filter((c) => c.step === 'coding').at(-1)!;
    expect(retry.resume).toBeUndefined();
    expect(retry.prompt).toContain('Call it greet, not hello');
    expect(pipeline.getTask(task.id).feedback).toBeNull();
  });

  it('starts the coder fresh after a new plan, and keeps a note I sent while the architect planned', async () => {
    const task = pipeline.createTask({ repoId: repo.id, input: 'Add a greeting helper' });
    await settle();
    await pipeline.decideGate(planGate(task).id, 'approve');
    await settle();
    runner.queue('planning', () => {
      pipeline.steer(task.id, 'name it greeter'); // not live: kept for the next step
      return { text: docs.plan };
    });
    pipeline.replanNow(task.id, 'use a lookup table');
    await settle();
    expect(pipeline.getTask(task.id).feedback).toBe('The owner says: name it greeter');
    await pipeline.decideGate(planGate(task).id, 'approve');
    await settle();
    const coder = runner.calls.filter((c) => c.step === 'coding').at(-1)!;
    expect(coder.resume).toBeUndefined();
    expect(coder.prompt).toContain('name it greeter');
    expect(coder.prompt).not.toContain('use a lookup table');
  });

  it("doesn't push fixes into a PR that was merged on GitHub meanwhile", async () => {
    const task = await atMergeGate();
    runner.queue('coding', (req) => {
      publisher.state = 'MERGED'; // I merged the old version on GitHub while the fix ran
      writeFileSync(join(req.cwd, 'src', 'greet.ts'), 'export const greet = () => "fixed";\n');
      return { text: docs.changes };
    });
    const pushes = publisher.pushed.length;
    await pipeline.decideGate(mergeGate(task).id, 'reject', 'Say fixed');
    await settle();
    expect(pipeline.getTask(task.id)).toMatchObject({ status: 'blocked', statusNote: expect.stringContaining('merged on GitHub while these changes were made') });
    expect(publisher.pushed.length).toBe(pushes);
  });

  it('keeps reviewing the fixes of a solo task that was reviewed once', async () => {
    solo();
    runner.queue(
      'coding',
      (req) => {
        req.onEvent('tool', { tool: 'Bash', input: 'curl -s https://example.com/api-docs' });
        writeFileSync(join(req.cwd, 'src', 'greet.ts'), 'export const greet = () => "v1";\n');
        return { text: docs.changes };
      },
      (req) => {
        writeFileSync(join(req.cwd, 'src', 'greet.ts'), 'export const greet = () => "v2";\n');
        return { text: docs.changes };
      },
    );
    runner.queue('reviewing', () => ({ text: docs.reviewFail }));
    const task = pipeline.createTask({ repoId: repo.id, input: 'Use the greeting from the API docs' });
    await settle();
    expect(steps()).toEqual(['intake', 'coding', 'reviewing', 'coding', 'reviewing']);
    expect(eventsOf(task, 'review_added').map((e) => e.payload.reason)).toEqual(['it read web pages while working', 'its earlier version was reviewed, so the fixes are too']);
  });

  it('gives a solo change one review when the all-rounder read web pages', async () => {
    solo();
    runner.queue('coding', (req) => {
      req.onEvent('tool', { tool: 'WebFetch', input: 'https://example.com/docs' });
      writeFileSync(join(req.cwd, 'src', 'greet.ts'), 'export const greet = () => "hi";\n');
      return { text: docs.changes };
    });
    const task = pipeline.createTask({ repoId: repo.id, input: 'Use the greeting from the docs' });
    await settle();
    expect(steps()).toEqual(['intake', 'coding', 'reviewing']);
    expect(eventsOf(task, 'review_added')[0]!.payload.reason).toBe('it read web pages while working');
  });

  describe('stacked milestones', () => {
    const stack = async () => {
      runner.queue('intake', () => ({ text: docs.task({ size: 'L', epic: true }) }));
      runner.queue('splitting', () => ({
        text: '---\nmilestones: 2\n---\n## Overview\nx\n\n## Milestones\n### 1. One\nDo one.\n\n### 2. Two\nDo two.\n\n## Not in these milestones\n- nothing',
      }));
      const epic = pipeline.createTask({ repoId: repo.id, input: 'Build a chat app' });
      await settle();
      await pipeline.decideGate(pipeline.pendingGates(epic.id).find((g) => g.kind === 'breakdown')!.id, 'approve');
      const [a, b] = db.select().from(schema.tasks).where(eq(schema.tasks.parentId, epic.id)).all();
      await settle();
      await pipeline.decideGate(planGate(a!).id, 'approve');
      await settle();
      await pipeline.decideGate(planGate(b!).id, 'approve');
      await settle();
      expect(pipeline.getTask(b!.id).baseBranch).toBe(pipeline.getTask(a!.id).branch);
      return { a: a!, b: b! };
    };

    it("refuses to merge a milestone whose predecessor was discarded: it still carries that work", async () => {
      const { a, b } = await stack();
      await pipeline.action(a.id, 'discard');
      await pipeline.decideGate(mergeGate(b).id, 'approve');
      expect(statusOf(b)).toBe('awaiting_merge_approval');
      expect(pipeline.getTask(b.id).statusNote).toContain(`milestone #${a.id}, which was discarded`);
      expect(publisher.merged).toEqual([]);
    });

    it("refuses when the predecessor was marked done without its PR merging", async () => {
      const { a, b } = await stack();
      await pipeline.action(a.id, 'done');
      await pipeline.decideGate(mergeGate(b).id, 'approve');
      expect(pipeline.getTask(b.id).statusNote).toContain('finished without its PR merging');
      expect(publisher.retargeted).toEqual([]);
      expect(publisher.merged).toEqual([]);
    });

    it('opens a later milestone\'s PR against the default branch once its predecessor has merged', async () => {
      runner.queue('intake', () => ({ text: docs.task({ size: 'L', epic: true }) }));
      runner.queue('splitting', () => ({
        text: '---\nmilestones: 2\n---\n## Overview\nx\n\n## Milestones\n### 1. One\nDo one.\n\n### 2. Two\nDo two.\n\n## Not in these milestones\n- nothing',
      }));
      const epic = pipeline.createTask({ repoId: repo.id, input: 'Build a chat app' });
      await settle();
      await pipeline.decideGate(pipeline.pendingGates(epic.id).find((g) => g.kind === 'breakdown')!.id, 'approve');
      const [a, b] = db.select().from(schema.tasks).where(eq(schema.tasks.parentId, epic.id)).all();
      await settle();
      await pipeline.decideGate(planGate(a!).id, 'approve');
      await settle();
      await settle(); // b plans on a's branch
      await pipeline.decideGate(mergeGate(a!).id, 'approve'); // a merges (its branch may be deleted)
      await pipeline.decideGate(planGate(b!).id, 'approve');
      await settle();
      expect(publisher.bases.at(-1)).toBe('main');
      expect(pipeline.getTask(b!.id).baseBranch).toBeNull();
      expect(statusOf(b!)).toBe('awaiting_merge_approval');
    });
  });
});

// ---------------------------------------------------------------- PR reviews

/** A bare "GitHub" with main and refs/pull/1/head (branch feature adds src/feature.ts). */
function addOriginWithPr(): void {
  const origin = join(home, 'origin.git');
  const g = (cmd: string) => execSync(cmd, { cwd: repo.path, stdio: 'pipe' });
  execSync(`git clone -q --bare "${repo.path}" "${origin}"`);
  g(`git remote add origin "${origin}"`);
  g('git checkout -q -b feature');
  writeFileSync(join(repo.path, 'src', 'feature.ts'), 'export const a = 1;\nexport const b = 2;\n');
  g('git add . && git -c user.name=o -c user.email=o@o commit -qm feature');
  g('git push -q origin feature feature:refs/pull/1/head');
  g('git checkout -q main');
}

describe('pr reviews', () => {
  it('drafts a review, lets me edit it, and posts inline comments only on diff lines', async () => {
    addOriginWithPr();
    const task = await pipeline.createReviewTask('https://github.com/acme/app/pull/1');
    await settle();
    expect(statusOf(task)).toBe('awaiting_review_post');
    expect(runner.calls.map((c) => c.step)).toEqual(['reviewing_pr']);
    expect(runner.calls[0]!.prompt).toContain('src/feature.ts'); // the PR diff is in the prompt

    const comments = pipeline.reviewComments(task.id);
    expect(comments.map((c) => c.severity)).toEqual(['blocking', 'nit', 'suggestion']);
    pipeline.editReviewComment(comments[0]!.id, { body: 'returns 2 but should return 3' });
    pipeline.editReviewComment(comments[2]!.id, { deleted: true });
    pipeline.editReviewSummary(task.id, 'Nice feature, one bug.');

    const gate = pipeline.pendingGates(task.id).find((g) => g.kind === 'review_post')!;
    await pipeline.decideGate(gate.id, 'approve');
    const t = pipeline.getTask(task.id);
    expect(t.status).toBe('done');
    expect(t.reviewPostedUrl).toContain('pullrequestreview');
    expect(t.worktreePath).toBeNull();

    const posted = publisher.posted[0]!;
    expect(posted.comments).toEqual([{ path: 'src/feature.ts', line: 2, body: '**Blocking:** returns 2 but should return 3' }]);
    expect(posted.body).toContain('Nice feature, one bug.');
    expect(posted.body).toContain('README.md:1'); // outside the diff: moved into the body, not dropped
    expect(posted.commitId).toMatch(/^[0-9a-f]{40}$/);
    expect(posted.body).toContain(`<!-- pixel-office review task #${task.id} -->`);
    expect(publisher.markers).toHaveLength(0); // a fresh post never searches for "already posted"
  });

  it('sends a rejected draft back to the reviewer with my comment', async () => {
    addOriginWithPr();
    const task = await pipeline.createReviewTask('https://github.com/acme/app/pull/1');
    await settle();
    const gate = pipeline.pendingGates(task.id).find((g) => g.kind === 'review_post')!;
    await pipeline.decideGate(gate.id, 'reject', 'focus on the API change');
    await settle();
    expect(runner.calls.map((c) => c.step)).toEqual(['reviewing_pr', 'reviewing_pr']);
    expect(runner.calls[1]!.prompt).toContain('focus on the API change');
    expect(publisher.posted).toHaveLength(0);
  });

  it('turns blocking findings on my own PR into a task targeting its branch', async () => {
    addOriginWithPr();
    const review = await pipeline.createReviewTask('https://github.com/acme/app/pull/1');
    await settle();
    const fix = await pipeline.fixIt(review.id);
    expect(fix.baseBranch).toBe('feature');
    expect(fix.input).toContain('src/feature.ts:2');
    await settle();
    await pipeline.decideGate(planGate(fix).id, 'approve');
    await settle();
    expect(publisher.bases).toEqual(['feature']);
    const wt = pipeline.getTask(fix.id).worktreePath!;
    expect(execSync(`git -C "${wt}" log --format=%s -1 ${pipeline.getTask(fix.id).baseSha}`).toString()).toContain('feature');
  });

  it('refuses "fix it" on a PR by someone else', async () => {
    addOriginWithPr();
    publisher.me = 'someone-else';
    const review = await pipeline.createReviewTask('https://github.com/acme/app/pull/1');
    await settle();
    await expect(pipeline.fixIt(review.id)).rejects.toThrow(/your own PRs/);
  });

  it('picks up requested reviews once, only for registered repos', async () => {
    addOriginWithPr();
    setSetting(db, 'reviewAutoPickup', true);
    publisher.requests = [
      { url: 'https://github.com/acme/app/pull/1', repo: 'acme/app', number: 1, title: 'Add feature', changedLines: -1 },
      { url: 'https://github.com/other/thing/pull/9', repo: 'other/thing', number: 9, title: 'x', changedLines: -1 },
    ];
    expect(await pipeline.pickUpReviews()).toBe(1);
    expect(await pipeline.pickUpReviews()).toBe(0);
    setSetting(db, 'reviewAutoPickup', false);
    publisher.requests = [{ url: 'https://github.com/acme/app/pull/2', repo: 'acme/app', number: 2, title: 'y', changedLines: -1 }];
    expect(await pipeline.pickUpReviews()).toBe(0);
  });

  it('rejects PRs from repos that are not registered', async () => {
    await expect(pipeline.createReviewTask('https://github.com/other/thing/pull/9')).rejects.toThrow(/isn't a registered repo/);
  });

  it('auto-pickup is off by default', async () => {
    addOriginWithPr();
    publisher.requests = [{ url: 'https://github.com/acme/app/pull/1', repo: 'acme/app', number: 1, title: 'x', changedLines: -1 }];
    expect(await pipeline.pickUpReviews()).toBe(0);
  });

  it('never runs code from the PR: no setup command and no shell for the reviewer', async () => {
    addOriginWithPr();
    const { updateRepo } = await import('../server/src/repos.js');
    await updateRepo(db, repo.id, { ...repo, setupCmd: 'touch .setup-ran' });
    let seen: RunRequest | undefined;
    runner.queue('reviewing_pr', (req) => ((seen = req), { text: docs.prReview }));
    const task = await pipeline.createReviewTask('https://github.com/acme/app/pull/1');
    await settle();
    expect(existsSync(join(pipeline.getTask(task.id).worktreePath!, '.setup-ran'))).toBe(false);
    expect(seen!.agent.tools).not.toContain('Bash');
    expect(seen!.agent.tools).toEqual(expect.arrayContaining(['Read', 'Grep', 'Glob']));
    expect(seen!.guard.allowlist).toEqual([]);
  });

  it('returns to the editable draft when GitHub rejects the post', async () => {
    addOriginWithPr();
    publisher.failPost = true;
    const task = await pipeline.createReviewTask('https://github.com/acme/app/pull/1');
    await settle();
    await pipeline.decideGate(pipeline.pendingGates(task.id)[0]!.id, 'approve');
    const t = pipeline.getTask(task.id);
    expect(t.status).toBe('awaiting_review_post');
    expect(t.statusNote).toMatch(/422/);
    const c = pipeline.reviewComments(task.id)[0]!;
    pipeline.editReviewComment(c.id, { deleted: true }); // still editable
    publisher.failPost = false;
    await pipeline.decideGate(pipeline.pendingGates(task.id)[0]!.id, 'approve');
    expect(statusOf(task)).toBe('done');
    expect(publisher.posted[0]!.comments.map((c) => `${c.path}:${c.line}`)).toEqual(['src/feature.ts:1']); // the deleted one is gone
  });

  it('posts my draft even when I already reviewed that commit by hand', async () => {
    addOriginWithPr();
    publisher.alreadyPosted = 'https://github.com/acme/app/pull/1#pullrequestreview-hand-written';
    const task = await pipeline.createReviewTask('https://github.com/acme/app/pull/1');
    await settle();
    await pipeline.decideGate(pipeline.pendingGates(task.id)[0]!.id, 'approve');
    expect(publisher.posted).toHaveLength(1);
  });

  it('does not post twice when GitHub already has the review (restart during posting)', async () => {
    addOriginWithPr();
    const task = await pipeline.createReviewTask('https://github.com/acme/app/pull/1');
    await settle();
    // Simulate a crash mid-post: the task is left in posting_review, then the server restarts.
    db.update(schema.tasks).set({ status: 'posting_review' }).where(eq(schema.tasks.id, task.id)).run();
    const restarted = makePipeline();
    restarted.recover();
    expect(restarted.getTask(task.id).status).toBe('paused');
    publisher.alreadyPosted = 'https://github.com/acme/app/pull/1#pullrequestreview-9';
    await restarted.action(task.id, 'resume');
    const t = restarted.getTask(task.id);
    expect(t.status).toBe('done');
    expect(t.reviewPostedUrl).toContain('review-9');
    expect(publisher.posted).toHaveLength(0);
    expect(publisher.markers).toEqual([`<!-- pixel-office review task #${task.id} -->`]);
    await restarted.shutdown();
  });

  it('refuses "fix it" for a PR from a fork', async () => {
    addOriginWithPr();
    publisher.headRepo = 'someone/app-fork';
    const review = await pipeline.createReviewTask('https://github.com/acme/app/pull/1');
    await settle();
    await expect(pipeline.fixIt(review.id)).rejects.toThrow(/fork/);
  });

  it('a custom reviewer definition cannot widen what the PR reviewer may do', async () => {
    addOriginWithPr();
    const agents = loadAgents(join(appDir, 'agents'), join(appDir, 'skills'));
    pipeline.setAgents({ ...agents, reviewer: { ...agents.reviewer, tools: ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'WebFetch'], write: 'all' } });
    let seen: RunRequest | undefined;
    runner.queue('reviewing_pr', (req) => ((seen = req), { text: docs.prReview }));
    await pipeline.createReviewTask('https://github.com/acme/app/pull/1');
    await settle();
    expect(seen!.agent.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(seen!.agent.write).toBe('none');
    expect(seen!.guard.write).toBe('none');
  });

  it('treats PR links case-insensitively and never picks up twice, even concurrently', async () => {
    addOriginWithPr();
    setSetting(db, 'reviewAutoPickup', true);
    const manual = await pipeline.createReviewTask('https://github.com/ACME/App/pull/1');
    expect(manual.prUrl).toBe('https://github.com/acme/app/pull/1');
    publisher.requests = [
      { url: 'https://github.com/Acme/App/pull/1', repo: 'acme/app', number: 1, title: 'x', changedLines: -1 },
      { url: 'https://github.com/acme/app/pull/2', repo: 'acme/app', number: 2, title: 'y', changedLines: -1 },
    ];
    const [a, b] = await Promise.all([pipeline.pickUpReviews(), pipeline.pickUpReviews()]);
    expect(a + b).toBe(1);
    expect(db.select().from(schema.tasks).all().filter((t) => t.kind === 'review')).toHaveLength(2);
  });

  it('skips PRs below the size threshold and remembers that', async () => {
    addOriginWithPr();
    setSetting(db, 'reviewAutoPickup', true);
    setSetting(db, 'reviewMinLines', 50);
    publisher.requests = [{ url: 'https://github.com/acme/app/pull/1', repo: 'acme/app', number: 1, title: 'x', changedLines: -1 }];
    expect(await pipeline.pickUpReviews()).toBe(0);
    const calls = publisher.prInfoCalls;
    expect(await pipeline.pickUpReviews()).toBe(0);
    expect(publisher.prInfoCalls).toBe(calls);
  });
});
