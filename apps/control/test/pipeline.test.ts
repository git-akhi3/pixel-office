import { execSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAgents } from '../server/src/agents.js';
import { ensureDirs, loadConfig, type OfficeConfig } from '../server/src/config.js';
import { openDb, setSetting, type Db } from '../server/src/db/index.js';
import type { Repo, Task } from '../server/src/db/schema.js';
import type { TaskStatus } from '../server/src/domain.js';
import { EventBus } from '../server/src/events.js';
import type { Publisher } from '../server/src/github.js';
import { TaskDocs } from '../server/src/handoffs.js';
import { Pipeline } from '../server/src/pipeline.js';
import { createRepo, getRepo } from '../server/src/repos.js';
import { emptyUsage, type AgentRunner, type RunOutcome, type RunRequest } from '../server/src/runner.js';

const appDir = resolve(import.meta.dirname, '..');

// ---------------------------------------------------------------- fakes

const docs = {
  task: (o: Partial<{ debugger: boolean }> = {}) =>
    `---\ntitle: Add greeting\nkind: feature\nsize: S\nneeds_debugger: ${!!o.debugger}\nneeds_researcher: false\ndesign_review: false\n---\n## Request\nAdd a greeting.\n\n## Draft acceptance criteria\n- greet() returns hello`,
  diagnosis: '---\nreproduced: true\n---\n## Root cause\nx',
  plan: '---\nfiles_in_scope:\n  - src/**\ntoken_estimate: 1000\n---\n## Goal\nAdd greet().\n\n## Steps\n1. src/greet.ts: add greet()',
  changes: '---\nstatus: done\n---\n## Changes\n- Step 1: added src/greet.ts\n\n## PR\n**Title:** Add greet helper\n**Summary:**\n- adds greet()\n**How it was tested:** npm test',
  blocked: '---\nstatus: blocked\n---\n## Question\nThe plan names a file that does not exist.',
  reviewPass: '---\nverdict: pass\nblocking: 0\n---\n## Summary\nfine\n\n## Findings\n- none',
  reviewFail: '---\nverdict: fail\nblocking: 1\n---\n## Summary\nbug\n\n## Findings\n- [blocking] src/greet.ts:1 — wrong',
  testPass: '---\nresult: pass\ntests_added: 1\n---\n## Suite\nnpm test: 1 passed',
  testFail: '---\nresult: fail\ntests_added: 1\n---\n## Suite\nnpm test: 1 failed',
  retro: '---\n---\n- **Went well:** fast\n- **Went wrong:** none\n- **Knowledge-file edit:** none',
};

type Script = (req: RunRequest) => Promise<Partial<RunOutcome> & { text?: string }> | (Partial<RunOutcome> & { text?: string });

class FakeRunner implements AgentRunner {
  calls: Array<{ step: string; prompt: string }> = [];
  active = 0;
  maxActive = 0;
  overrides: Partial<Record<string, Script[]>> = {};

  constructor(private stepOf: (taskId: number) => TaskStatus) {}

  queue(step: string, ...scripts: Script[]): void {
    this.overrides[step] = [...(this.overrides[step] ?? []), ...scripts];
  }

  steer(): boolean {
    return false;
  }

  async run(req: RunRequest): Promise<RunOutcome> {
    const step = this.stepOf(req.taskId);
    this.calls.push({ step, prompt: req.prompt });
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      const script = this.overrides[step]?.shift();
      const result = script ? await script(req) : { text: this.defaultText(step, req) };
      return { status: 'ok', text: '', usage: { ...emptyUsage(), input: 100, output: 50 }, durationMs: 1, ...result };
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
  state: 'OPEN' | 'MERGED' = 'OPEN';
  async pushAndOpenDraftPr(_repo: Repo, _wt: string, branch: string): Promise<string> {
    this.pushed.push(branch);
    return `https://github.com/acme/app/pull/${this.pushed.length}`;
  }
  async prState(): Promise<'OPEN' | 'MERGED'> {
    return this.state;
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

function makePipeline(): Pipeline {
  return new Pipeline({
    db,
    bus,
    config,
    agents: loadAgents(join(appDir, 'agents'), join(appDir, 'skills')),
    runner,
    publisher,
    docs: new TaskDocs(config.tasksDir),
  });
}

beforeEach(async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'office-test-')));
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
const pushGate = (t: Task) => pipeline.pendingGates(t.id).find((g) => g.kind === 'push')!;

// ---------------------------------------------------------------- tests

describe('pipeline', () => {
  it('runs the happy path with two approvals and opens a draft PR', async () => {
    const task = pipeline.createTask({ repoId: repo.id, input: 'Add a greeting helper' });
    await settle();
    expect(statusOf(task)).toBe('awaiting_plan_approval');
    expect(pipeline.getTask(task.id).title).toBe('Add greeting');
    expect(pipeline.getTask(task.id).filesInScope).toEqual(['src/**']);

    await pipeline.decideGate(planGate(task).id, 'approve');
    await settle();
    expect(statusOf(task)).toBe('awaiting_push_approval');
    expect(steps()).toEqual(['intake', 'planning', 'coding', 'reviewing', 'testing']);

    const t = pipeline.getTask(task.id);
    expect(t.branch).toMatch(/^office\/1-/);
    const log = execSync(`git -C "${t.worktreePath}" log --format=%s ${t.baseSha}..HEAD`).toString();
    expect(log).toContain('Add greet helper');
    expect(log).toContain('test: Add greeting');

    await pipeline.decideGate(pushGate(task).id, 'approve');
    expect(statusOf(task)).toBe('pr_open');
    expect(publisher.pushed).toEqual([t.branch]);

    await pipeline.action(task.id, 'done');
    await settle();
    expect(statusOf(task)).toBe('done');
    expect(steps().at(-1)).toBe('retro');
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
    expect(pushGate(b)).toBeTruthy();
    await pipeline.action(b.id, 'done');
    expect(pipeline.pendingGates(b.id)).toHaveLength(0);
    await settle();
    expect(statusOf(b)).toBe('done');
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
    expect(statusOf(task)).toBe('awaiting_push_approval');
  });

  it('auto-approves the push when the toggle is on (review and tests passed)', async () => {
    setSetting(db, 'autoApprovePush', true);
    const task = pipeline.createTask({ repoId: repo.id, input: 'x' });
    await settle();
    await pipeline.decideGate(planGate(task).id, 'approve');
    await settle();
    expect(statusOf(task)).toBe('pr_open');
    expect(publisher.pushed).toHaveLength(1);
  });

  it('never auto-approves the plan', async () => {
    setSetting(db, 'autoApprovePush', true);
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

  it('moves a merged PR to retro and removes the worktree', async () => {
    setSetting(db, 'autoApprovePush', true);
    const task = pipeline.createTask({ repoId: repo.id, input: 'x' });
    await settle();
    await pipeline.decideGate(planGate(task).id, 'approve');
    await settle();
    publisher.state = 'MERGED';
    await pipeline.sweep();
    await settle();
    const t = pipeline.getTask(task.id);
    expect(t.status).toBe('done');
    expect(t.worktreePath).toBeNull();
  });
});
