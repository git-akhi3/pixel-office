import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAgents, systemPromptFor } from '../server/src/agents.js';
import { answersMessage, briefDoc, parseRound } from '../server/src/briefing.js';
import { ensureDirs, loadConfig, type OfficeConfig } from '../server/src/config.js';
import { openDb, schema, type Db } from '../server/src/db/index.js';
import type { Question, Repo, Task } from '../server/src/db/schema.js';
import { EventBus } from '../server/src/events.js';
import type { Publisher } from '../server/src/github.js';
import { Graphs } from '../server/src/graph.js';
import { TaskDocs } from '../server/src/handoffs.js';
import { Knowledge } from '../server/src/knowledge.js';
import { Pipeline } from '../server/src/pipeline.js';
import { createRepo } from '../server/src/repos.js';
import { emptyUsage, type AgentRunner, type RunOutcome, type RunRequest } from '../server/src/runner.js';

const appDir = resolve(import.meta.dirname, '..');
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'office-briefing-')));

const intake = (extra = '') =>
  `---\ntitle: Add variants\nkind: feature\nsize: L\nneeds_debugger: false\nneeds_researcher: false\ndesign_review: false\n${extra}---\n## Request\nAdd variants.`;
const plan = '---\nfiles_in_scope:\n  - src/**\ntoken_estimate: 1000\n---\n## Goal\nVariants.';
const round = (...titles: string[]) =>
  `---\nquestions:\n${titles.map((t) => `  - title: ${t}\n    question: What about ${t}?\n    options: [A, B]\n    recommended: A, because it is simpler\n`).join('')}---`;

/**
 * A fake planning session that behaves like SdkRunner with interject: each scripted output is a
 * final message; interject's reply is "sent" as the next user message.
 */
class SessionRunner implements AgentRunner {
  runs: Array<{ step: string; prompt: string; system: string; sent: string[]; outcome?: string }> = [];
  scripts: Record<string, string[][]> = {};
  intakeText = intake();
  constructor(private stepOf: (id: number) => string) {}
  steer(): boolean {
    return false; // a session waiting on interject never takes a steer directly
  }
  async run(req: RunRequest): Promise<RunOutcome> {
    const step = this.stepOf(req.taskId);
    const record: { step: string; prompt: string; system: string; sent: string[]; outcome?: string } = { step, prompt: req.prompt, system: systemPromptFor(req.agent), sent: [] };
    this.runs.push(record);
    const outputs = step === 'planning' ? (this.scripts.planning?.shift() ?? [plan]) : [step === 'intake' ? this.intakeText : ''];
    for (const text of outputs) {
      if (req.interject) {
        const reply = await req.interject(text);
        if (req.signal.aborted) return this.done(record, 'interrupted', text);
        if (reply === 'park') return this.done(record, 'parked', text);
        if (reply !== null) {
          record.sent.push(reply);
          continue;
        }
      }
      if (req.validate?.(text)) return this.done(record, 'failed', text);
      return this.done(record, 'ok', text);
    }
    return this.done(record, 'failed', '');
  }
  private done(record: { outcome?: string }, status: RunOutcome['status'], text: string): RunOutcome {
    record.outcome = status;
    return { status, text, usage: emptyUsage(), durationMs: 1 };
  }
}

let config: OfficeConfig;
let db: Db;
let repo: Repo;
let runner: SessionRunner;
let pipeline: Pipeline;
let bus: EventBus;

function makePipeline(waitMs = 5000): Pipeline {
  return new Pipeline({
    db,
    bus,
    config,
    agents: loadAgents(join(appDir, 'agents'), [config.customSkillsDir, join(appDir, 'skills')]),
    runner,
    publisher: {} as Publisher,
    docs: new TaskDocs(config.tasksDir),
    knowledge: new Knowledge(db, config.knowledgeDir),
    graphs: new Graphs(config.graphsDir),
    slugOf: async () => 'acme/app',
    briefingWaitMs: waitMs,
  });
}

beforeEach(async () => {
  const home = tmp();
  config = loadConfig({ OFFICE_HOME: join(home, 'office') });
  ensureDirs(config);
  mkdirSync(join(config.customSkillsDir, 'grilling'), { recursive: true });
  writeFileSync(join(config.customSkillsDir, 'grilling', 'SKILL.md'), '---\nname: grilling\ndescription: Interview the owner.\n---\nWork the design tree in rounds.\n');
  const repoPath = join(home, 'app');
  execSync(`mkdir -p "${repoPath}/src" && cd "${repoPath}" && git init -q -b main && echo x > README.md && git add . && git -c user.name=t -c user.email=t@t commit -qm init`);
  db = openDb(config.dbPath);
  bus = new EventBus(db);
  repo = await createRepo(db, { name: 'app', path: repoPath, gitAuthor: 'T <t@t.dev>' });
  runner = new SessionRunner((id) => pipeline.getTask(id).status);
  pipeline = makePipeline();
});

afterEach(async () => {
  await pipeline.shutdown();
});

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
    await pipeline.tick();
  }
}
async function settle() {
  for (let i = 0; i < 5; i++) {
    await pipeline.tick();
    await pipeline.idle();
  }
}
const get = (t: Task) => pipeline.getTask(t.id);
const openQs = (t: Task): Question[] => pipeline.questions(t.id).filter((q) => q.answer === null && !q.delegated);
const events = (t: Task, type: string) => db.select().from(schema.events).all().filter((e) => e.taskId === t.id && e.type === type);

describe('question rounds', () => {
  it('parses a round, flags a malformed one, and lets a plan through', () => {
    expect(parseRound(round('Stock', 'Pricing'))).toEqual([
      { title: 'Stock', question: 'What about Stock?', options: ['A', 'B'], recommended: 'A, because it is simpler' },
      { title: 'Pricing', question: 'What about Pricing?', options: ['A', 'B'], recommended: 'A, because it is simpler' },
    ]);
    expect(parseRound(plan)).toBeNull();
    expect(parseRound('---\nquestions: []\n---')).toMatch(/doesn't match the format/);
    expect(parseRound('---\nquestions:\n  - title: x\n---')).toMatch(/question/);
  });

  it('writes answers, delegations and gaps clearly for the architect, and a brief of decisions', () => {
    const q = (o: Partial<Question>): Question =>
      ({ id: 1, taskId: 1, gateId: 1, runId: 1, round: 2, idx: 0, title: 'T', body: 'B', options: [], recommended: 'A', answer: null, answeredVia: null, delegated: false, answeredAt: null, slackTs: null, createdAt: 0, ...o }) as Question;
    const qs = [q({ title: 'Stock', answer: 'Per variant' }), q({ title: 'Price', delegated: true }), q({ title: 'Images' })];
    const sent = answersMessage(2, qs, 'send', ['also keep the old API']);
    expect(sent).toContain('1. Stock: Per variant');
    expect(sent).toContain('2. Price: you decide (your recommendation: A)');
    expect(sent).toContain('3. Images: not answered yet');
    expect(sent).toContain('The owner also says: also keep the old API');
    expect(answersMessage(2, qs, 'enough')).toContain('enough questions. Write the plan now');
    const brief = briefDoc(qs);
    expect(brief).toContain('### Round 2');
    expect(brief).toContain('- **Stock:** Per variant');
    expect(brief).not.toContain('Images');
  });
});

describe('briefing in planning', () => {
  it('on Auto, the manager turns it on; the architect asks, I answer, it plans', async () => {
    runner.intakeText = intake('grill: true\ngrill_reason: unclear whether variants share stock\n');
    runner.scripts.planning = [[round('Stock', 'Pricing'), plan]];
    const task = pipeline.createTask({ repoId: repo.id, input: 'Add variants' });
    await until(() => openQs(task).length === 2);
    expect(get(task)).toMatchObject({ grill: true, grillReason: 'unclear whether variants share stock', status: 'planning' });
    expect(pipeline.pendingGates(task.id).map((g) => [g.kind, g.subject])).toEqual([['question', 'Round 1: 2 questions']]);
    expect(get(task).statusNote).toMatch(/waiting for your answers \(2 open questions\)/);
    const planning = runner.runs.find((r) => r.step === 'planning')!;
    expect(planning.prompt).toContain('## Asking the owner (briefing)');
    expect(planning.system).toContain('## Skill: grilling');

    const [q1, q2] = openQs(task);
    pipeline.answerQuestion(q1!.id, { text: 'Per variant' }, 'slack');
    expect(() => pipeline.answerQuestion(q1!.id, { text: 'Shared' }, 'board')).toThrow(/Already answered on Slack/);
    pipeline.answerQuestion(q2!.id, { delegate: true }, 'board');
    await settle();

    expect(planning.sent).toHaveLength(1);
    expect(planning.sent[0]).toContain('1. Stock: Per variant');
    expect(planning.sent[0]).toContain('2. Pricing: you decide');
    expect(get(task).status).toBe('awaiting_plan_approval');
    const brief = new TaskDocs(config.tasksDir).latest(task.id, 'brief')!;
    expect(brief).toContain('- **Stock:** Per variant');
    expect(pipeline.pendingGates(task.id).map((g) => g.kind)).toEqual(['plan']);
  });

  it('my Never and Always win over the manager', async () => {
    runner.intakeText = intake('grill: true\n');
    const never = pipeline.createTask({ repoId: repo.id, input: 'A', grillMode: 'never' });
    await settle();
    expect(get(never)).toMatchObject({ grill: false, grillReason: 'You set Grill me to Never.', status: 'awaiting_plan_approval' });
    expect(runner.runs.find((r) => r.step === 'planning')!.prompt).not.toContain('Asking the owner');
    runner.intakeText = intake('grill: false\n');
    const always = pipeline.createTask({ repoId: repo.id, input: 'B', grillMode: 'always' });
    await settle();
    expect(get(always)).toMatchObject({ grill: true, grillReason: 'You set Grill me to Always.' });
  });

  it('parks after the wait, frees the slot, and plans in a fresh session once I answer', async () => {
    await pipeline.shutdown();
    pipeline = makePipeline(40);
    runner.scripts.planning = [[round('Stock')], [plan]];
    const task = pipeline.createTask({ repoId: repo.id, input: 'Add variants', grillMode: 'always' });
    await until(() => get(task).status === 'awaiting_answer');
    expect(pipeline.isRunning(task.id)).toBe(false);
    expect(runner.runs.filter((r) => r.step === 'planning').map((r) => r.outcome)).toEqual(['parked']);
    pipeline.answerQuestion(openQs(task)[0]!.id, { text: 'Per variant' }, 'board');
    await settle();
    const second = runner.runs.filter((r) => r.step === 'planning')[1]!;
    expect(second.prompt).toContain('### brief.md');
    expect(second.prompt).toContain("The owner's answers to round 1:\n1. Stock: Per variant");
    expect(get(task).status).toBe('awaiting_plan_approval');
    expect(events(task, 'briefing_parked')).toHaveLength(1);
  });

  it('"Enough" ends the briefing: unanswered questions become assumptions, and no more rounds', async () => {
    runner.scripts.planning = [[round('Stock', 'Pricing'), round('Images'), plan]];
    const task = pipeline.createTask({ repoId: repo.id, input: 'Add variants', grillMode: 'always' });
    await until(() => openQs(task).length === 2);
    expect(() => pipeline.briefingAction(task.id, 'send')).toThrow(/at least one/);
    pipeline.answerQuestion(openQs(task)[0]!.id, { text: 'Per variant' }, 'board');
    pipeline.briefingAction(task.id, 'enough');
    await settle();
    const sent = runner.runs.find((r) => r.step === 'planning')!.sent;
    expect(sent[0]).toContain('2. Pricing: not answered: use your recommendation and list it under Risks');
    expect(sent[1]).toMatch(/already said that is enough questions/);
    expect(pipeline.questions(task.id).filter((q) => q.round === 2)).toHaveLength(0);
    expect(get(task).status).toBe('awaiting_plan_approval');
  });

  it('sends a malformed round back for a fix, then accepts the fixed one', async () => {
    runner.scripts.planning = [['---\nquestions:\n  - title: Stock\n---', round('Stock'), plan]];
    const task = pipeline.createTask({ repoId: repo.id, input: 'Add variants', grillMode: 'always' });
    await until(() => openQs(task).length === 1);
    expect(runner.runs.find((r) => r.step === 'planning')!.sent[0]).toMatch(/doesn't match the format/);
    pipeline.answerQuestion(openQs(task)[0]!.id, { text: 'Shared' }, 'board');
    await settle();
    expect(get(task).status).toBe('awaiting_plan_approval');
  });

  it('holds a message I send while the round is open and passes it on with the answers', async () => {
    runner.scripts.planning = [[round('Stock'), plan]];
    const task = pipeline.createTask({ repoId: repo.id, input: 'Add variants', grillMode: 'always' });
    await until(() => openQs(task).length === 1);
    expect(pipeline.steer(task.id, 'keep the old endpoint working')).toBe('next_step');
    pipeline.answerQuestion(openQs(task)[0]!.id, { text: 'Shared' }, 'board');
    await settle();
    expect(runner.runs.find((r) => r.step === 'planning')!.sent[0]).toContain('The owner also says: The owner says: keep the old endpoint working');
    expect(get(task).feedback).toBeNull();
  });

  it('stopping while the architect waits keeps the questions; resuming waits for them again', async () => {
    runner.scripts.planning = [[round('Stock')], [plan]];
    const task = pipeline.createTask({ repoId: repo.id, input: 'Add variants', grillMode: 'always' });
    await until(() => openQs(task).length === 1);
    await pipeline.action(task.id, 'stop');
    await settle();
    expect(get(task)).toMatchObject({ status: 'stopped', resumeStatus: 'awaiting_answer' });
    pipeline.answerQuestion(openQs(task)[0]!.id, { text: 'Shared' }, 'board');
    expect(get(task).status).toBe('stopped');
    await pipeline.action(task.id, 'resume');
    await settle();
    expect(get(task).status).toBe('awaiting_plan_approval');
    expect(runner.runs.filter((r) => r.step === 'planning')[1]!.prompt).toContain('1. Stock: Shared');
  });

  it('after a restart, an open round waits for me instead of re-running planning', async () => {
    runner.scripts.planning = [[round('Stock')]];
    const task = pipeline.createTask({ repoId: repo.id, input: 'Add variants', grillMode: 'always' });
    await until(() => openQs(task).length === 1);
    // The process dies: the running step is gone, the database keeps the round.
    pipeline.recover();
    expect(get(task).status).toBe('awaiting_answer');
    expect(pipeline.pendingGates(task.id).map((g) => g.kind)).toEqual(['question']);
  });

  it('discarding cancels the round; a closed round takes no answers', async () => {
    runner.scripts.planning = [[round('Stock')]];
    const task = pipeline.createTask({ repoId: repo.id, input: 'Add variants', grillMode: 'always' });
    await until(() => openQs(task).length === 1);
    const q = openQs(task)[0]!;
    await pipeline.action(task.id, 'discard');
    await settle();
    expect(() => pipeline.answerQuestion(q.id, { text: 'x' }, 'board')).toThrow(/round is closed/);
    await expect(pipeline.decideGate(q.gateId!, 'approve')).rejects.toThrow();
  });
});
