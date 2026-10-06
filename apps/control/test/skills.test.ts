import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isWrapperSkill, loadAgents, systemPromptFor, withSkills } from '../server/src/agents.js';
import { ensureDirs, loadConfig, type OfficeConfig } from '../server/src/config.js';
import { openDb, type Db } from '../server/src/db/index.js';
import type { Repo, Task } from '../server/src/db/schema.js';
import { EventBus } from '../server/src/events.js';
import type { Publisher } from '../server/src/github.js';
import { Graphs } from '../server/src/graph.js';
import { TaskDocs } from '../server/src/handoffs.js';
import { Knowledge } from '../server/src/knowledge.js';
import { Pipeline } from '../server/src/pipeline.js';
import { createRepo } from '../server/src/repos.js';
import { emptyUsage, type AgentRunner, type RunOutcome, type RunRequest } from '../server/src/runner.js';
import { SkillImporter } from '../server/src/skillImport.js';

const appDir = resolve(import.meta.dirname, '..');
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'office-skills-')));
const skillFile = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
function writeSkill(dir: string, name: string, description = `Use ${name}.`, body = `Do the ${name} thing.`): string {
  mkdirSync(join(dir, name), { recursive: true });
  const f = join(dir, name, 'SKILL.md');
  writeFileSync(f, skillFile(name, description, body));
  return f;
}

describe('skills in an agent', () => {
  it('adds mission skills to the prompt with the office adapter, and skips deleted ones when asked', () => {
    const dir = tmp();
    writeSkill(dir, 'grilling', 'Interview the owner.', 'Ask the user relentlessly.');
    const agents = loadAgents(join(appDir, 'agents'), [dir, join(appDir, 'skills')]);
    const missing: string[] = [];
    const a = withSkills(agents.architect, ['grilling', 'gone', 'grilling'], [dir], (n) => missing.push(n));
    expect(a.skills).toEqual(['grilling']);
    expect(missing).toEqual(['gone']);
    const prompt = systemPromptFor(a);
    expect(prompt).toContain('## How skills work in this office');
    expect(prompt).toContain('## Skill: grilling');
    expect(() => withSkills(agents.architect, ['gone'], [dir])).toThrow(/Unknown skill/);
    // No skills, no adapter text.
    expect(systemPromptFor(agents.manager)).not.toContain('How skills work');
  });

  it('recognises skills that only call other skills', () => {
    expect(isWrapperSkill('Call the Skill tool with "grilling".')).toBe(true);
    expect(isWrapperSkill('Call the Skill tool twice, for "grilling" and "domain-modeling".')).toBe(true);
    expect(isWrapperSkill('Interview the user.\n\nNever use the Skill tool for this.\n\n1. a\n2. b\n3. c\n4. d')).toBe(false);
  });
});

describe('importing skills from Claude Code', () => {
  function setup() {
    const root = tmp();
    const office = tmp();
    const plugin = join(root, 'cache', 'mattpocock');
    mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
    writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'mattpocock-skills' }));
    const grilling = writeSkill(join(plugin, 'skills', 'productivity'), 'grilling', 'Grill the user.', 'Interview relentlessly.');
    writeFileSync(join(plugin, 'skills', 'productivity', 'grilling', 'notes.md'), 'extra');
    writeSkill(join(plugin, 'skills', 'productivity'), 'grill-me', 'Grill me.', 'Call the Skill tool with "grilling".');
    const loose = tmp();
    writeSkill(loose, 'write-pr', 'Taken.'); // same name as a built-in office skill
    mkdirSync(join(loose, 'broken'));
    writeFileSync(join(loose, 'broken', 'SKILL.md'), 'no front matter');
    const existing = new Set(['write-pr']);
    const importer = new SkillImporter(
      [
        { label: 'plugins', dir: root },
        { label: '~/.claude/skills', dir: loose },
      ],
      office,
      () => existing,
    );
    return { importer, office, grilling, root, existing };
  }

  it('lists skills with their plugin, flags wrappers and name clashes, and skips broken files', () => {
    const { importer } = setup();
    const list = importer.list();
    expect(list.map((s) => [s.name, s.source, s.status, s.wrapper])).toEqual([
      ['write-pr', '~/.claude/skills', 'taken', false],
      ['grill-me', 'mattpocock-skills', 'new', true],
      ['grilling', 'mattpocock-skills', 'new', false],
    ]);
    expect(list.find((s) => s.name === 'grilling')!.extraFiles).toBe(1);
  });

  it('imports a snapshot with its source, then reports an update when the source changes', () => {
    const { importer, office, grilling, existing } = setup();
    const key = importer.list().find((s) => s.name === 'grilling')!.key;
    expect(importer.import(key)).toEqual({ name: 'grilling' });
    existing.add('grilling');
    expect(readFileSync(join(office, 'grilling', 'SKILL.md'), 'utf8')).toContain('Interview relentlessly.');
    expect(JSON.parse(readFileSync(join(office, 'grilling', '.source.json'), 'utf8'))).toMatchObject({ path: grilling, source: 'mattpocock-skills' });
    expect(importer.list(true).find((s) => s.name === 'grilling')!.status).toBe('imported');

    writeFileSync(grilling, skillFile('grilling', 'Grill the user.', 'Interview relentlessly, in rounds.'));
    expect(importer.list(true).find((s) => s.name === 'grilling')!.status).toBe('update');
    const d = importer.diff(key);
    expect(d.current).toContain('Interview relentlessly.');
    expect(d.incoming).toContain('in rounds');
    // The office copy only changes when I take the update.
    expect(readFileSync(join(office, 'grilling', 'SKILL.md'), 'utf8')).not.toContain('in rounds');
    importer.import(key);
    expect(readFileSync(join(office, 'grilling', 'SKILL.md'), 'utf8')).toContain('in rounds');
  });

  it('refuses unknown keys and never overwrites a skill from elsewhere', () => {
    const { importer } = setup();
    expect(() => importer.import('0123456789abcdef')).toThrow(/no longer there/);
    const taken = importer.list().find((s) => s.name === 'write-pr')!;
    expect(() => importer.import(taken.key)).toThrow(/already has a skill named "write-pr"/);
  });

  it('follows symlinks inside a root, lists each real file once, and ignores links leading outside', () => {
    const { importer, root, grilling } = setup();
    // A linked skill folder and a linked SKILL.md, both pointing at the same real file.
    symlinkSync(join(grilling, '..'), join(root, 'grilling-link'));
    mkdirSync(join(root, 'linked'));
    symlinkSync(grilling, join(root, 'linked', 'SKILL.md'));
    const outside = tmp();
    writeSkill(outside, 'secret-skill');
    symlinkSync(join(outside, 'secret-skill'), join(root, 'escape'));
    const list = importer.list(true);
    expect(list.filter((s) => s.name === 'grilling')).toHaveLength(1);
    expect(list.find((s) => s.name === 'secret-skill')).toBeUndefined();
    // A skill installed only as a link is found.
    const elsewhere = join(root, 'store', 'tdd');
    writeSkill(join(root, 'store'), 'tdd');
    mkdirSync(join(root, 'installed'));
    symlinkSync(elsewhere, join(root, 'installed', 'tdd'));
    expect(importer.list(true).filter((s) => s.name === 'tdd')).toHaveLength(1);
  });

  it('offers an update when a plugin upgrade moved the skill to a new versioned folder', () => {
    const { importer, root, existing, office } = setup();
    const plugin = join(root, 'cache', 'mattpocock');
    const key = importer.list().find((s) => s.name === 'grilling')!.key;
    importer.import(key);
    existing.add('grilling');
    // Upgrade: the old folder goes away, the skill appears under a new path in the same plugin.
    execSync(`mv "${join(plugin, 'skills')}" "${join(plugin, 'skills-1.3')}"`);
    writeFileSync(join(plugin, 'skills-1.3', 'productivity', 'grilling', 'SKILL.md'), skillFile('grilling', 'Grill the user.', 'New wording.'));
    const moved = importer.list(true).find((s) => s.name === 'grilling')!;
    expect(moved.status).toBe('update');
    importer.import(moved.key);
    expect(readFileSync(join(office, 'grilling', 'SKILL.md'), 'utf8')).toContain('New wording.');
    expect(importer.list(true).find((s) => s.name === 'grilling')!.status).toBe('imported');
  });
});

// ---------------------------------------------------------------- mission skills in the pipeline

const intake = (extra = '') =>
  `---\ntitle: Add greeting\nkind: feature\nsize: S\nneeds_debugger: false\nneeds_researcher: false\ndesign_review: false\n${extra}---\n## Request\nAdd a greeting.`;
const plan = '---\nfiles_in_scope:\n  - src/**\ntoken_estimate: 1000\n---\n## Goal\nx';

class Runner implements AgentRunner {
  calls: Array<{ step: string; prompt: string; skills: string[]; system: string }> = [];
  intakeText = intake();
  block: Promise<void> | null = null;
  constructor(private stepOf: (id: number) => string) {}
  steer(): boolean {
    return false;
  }
  async run(req: RunRequest): Promise<RunOutcome> {
    const step = this.stepOf(req.taskId);
    this.calls.push({ step, prompt: req.prompt, skills: req.agent.skills, system: systemPromptFor(req.agent) });
    if (this.block) await this.block;
    const text = step === 'intake' ? this.intakeText : step === 'planning' ? plan : '';
    return { status: 'ok', text, usage: emptyUsage(), durationMs: 1 };
  }
}

describe('mission skills', () => {
  let config: OfficeConfig;
  let db: Db;
  let repo: Repo;
  let runner: Runner;
  let pipeline: Pipeline;
  let bus: EventBus;

  beforeEach(async () => {
    const home = tmp();
    config = loadConfig({ OFFICE_HOME: join(home, 'office') });
    ensureDirs(config);
    writeSkill(config.customSkillsDir, 'grilling', 'Interview the owner about a plan.');
    writeSkill(config.customSkillsDir, 'fastify-conventions', 'Our Fastify route style.');
    writeSkill(config.customSkillsDir, 'grill-me', 'Grill me.', 'Call the Skill tool with "grilling".');
    const repoPath = join(home, 'app');
    execSync(`mkdir -p "${repoPath}/src" && cd "${repoPath}" && git init -q -b main && echo x > README.md && git add . && git -c user.name=t -c user.email=t@t commit -qm init`);
    db = openDb(config.dbPath);
    bus = new EventBus(db);
    repo = await createRepo(db, { name: 'app', path: repoPath, gitAuthor: 'T <t@t.dev>' });
    runner = new Runner((id) => pipeline.getTask(id).status);
    pipeline = new Pipeline({
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
    });
  });

  afterEach(async () => {
    await pipeline.shutdown();
  });

  async function settle() {
    for (let i = 0; i < 5; i++) {
      await pipeline.tick();
      await pipeline.idle();
    }
  }
  const get = (t: Task) => pipeline.getTask(t.id);

  it('shows the manager the catalog without wrappers, and keeps my locked picks', async () => {
    runner.intakeText = intake('skills:\n  architect: [fastify-conventions]\n  coder: [fastify-conventions, nope]\nskills_why:\n  coder: touches the routes\n');
    const task = pipeline.createTask({ repoId: repo.id, input: 'Add a route', skills: { architect: ['grilling'] } });
    await settle();
    const prompt = runner.calls.find((c) => c.step === 'intake')!.prompt;
    expect(prompt).toContain('- grilling: Interview the owner about a plan.');
    expect(prompt).not.toContain('grill-me');
    expect(prompt).toContain('The owner already chose for: architect: grilling');
    expect(prompt).toContain('Always on already');
    expect(get(task).skillPicks).toEqual({
      architect: { skills: ['grilling'], by: 'owner' },
      coder: { skills: ['fastify-conventions'], by: 'manager', why: 'touches the routes' },
    });
    const alerts = db.select().from((await import('../server/src/db/schema.js')).events).all().filter((e) => e.type === 'alert');
    expect(alerts.map((a) => a.payload.message)).toEqual([expect.stringContaining('left out: nope')]);
    // The architect ran with my pick on top of its defaults.
    const planning = runner.calls.find((c) => c.step === 'planning')!;
    expect(planning.skills).toContain('grilling');
    expect(planning.system).toContain('## Skill: grilling');
  });

  it("ignores a malformed skills hint instead of failing the intake, and never picks for the manager", async () => {
    runner.intakeText = intake('skills: coder\nskills_why: 3\n');
    const a = pipeline.createTask({ repoId: repo.id, input: 'One' });
    await settle();
    expect(get(a).status).toBe('awaiting_plan_approval');
    expect(get(a).skillPicks).toEqual({});
    runner.intakeText = intake('skills:\n  manager: [grilling]\n  coder: fastify-conventions\n');
    const b = pipeline.createTask({ repoId: repo.id, input: 'Two' });
    await settle();
    expect(get(b).skillPicks).toEqual({ coder: { skills: ['fastify-conventions'], by: 'manager' } });
  });

  it('rejects unknown skills and roles when I create a task', () => {
    expect(() => pipeline.createTask({ repoId: repo.id, input: 'x', skills: { coder: ['nope'] } })).toThrow(/Unknown skill/);
    expect(() => pipeline.createTask({ repoId: repo.id, input: 'x', skills: { manager: ['grilling'] } as never })).toThrow(/can't be picked for the manager/);
  });

  it('lets me change a role that is not working right now; the change locks that role', async () => {
    let release!: () => void;
    runner.block = new Promise((r) => (release = r));
    const task = pipeline.createTask({ repoId: repo.id, input: 'Add a route' });
    await pipeline.tick();
    expect(() => pipeline.setTaskSkills(task.id, 'coder', ['fastify-conventions'])).not.toThrow();
    expect(get(task).skillPicks.coder).toEqual({ skills: ['fastify-conventions'], by: 'owner' });
    release();
    runner.block = null;
    await settle();
    expect(get(task).status).toBe('awaiting_plan_approval');
    // While the architect is planning again, its own skills can't change.
    let release2!: () => void;
    runner.block = new Promise((r) => (release2 = r));
    pipeline.replanNow(task.id, 'again');
    await pipeline.tick();
    expect(() => pipeline.setTaskSkills(task.id, 'architect', ['grilling'])).toThrow(/working right now/);
    expect(() => pipeline.setTaskSkills(task.id, 'tester', ['grilling'])).not.toThrow();
    release2();
    await settle();
    expect(existsSync(config.customSkillsDir)).toBe(true);
  });
});
