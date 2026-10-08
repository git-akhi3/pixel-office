import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAgents } from '../server/src/agents.js';
import { ensureDirs, loadConfig } from '../server/src/config.js';
import { openDb } from '../server/src/db/index.js';
import { EventBus } from '../server/src/events.js';
import { TaskDocs } from '../server/src/handoffs.js';
import { Graphs } from '../server/src/graph.js';
import { Knowledge } from '../server/src/knowledge.js';
import { Pipeline } from '../server/src/pipeline.js';
import type { AgentRunner } from '../server/src/runner.js';
import { buildServer } from '../server/src/server.js';

const appDir = resolve(import.meta.dirname, '..');
let app: FastifyInstance;
let pipeline: Pipeline;
let repoPath: string;
let claudeSkillsDir: string;

const idleRunner: AgentRunner = {
  run: (req) => new Promise((res) => req.signal.addEventListener('abort', () => res({ status: 'interrupted', text: '', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 }, durationMs: 0 }))),
  steer: () => false,
};

beforeEach(async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'office-srv-')));
  claudeSkillsDir = join(home, 'claude-skills');
  const config = { ...loadConfig({ OFFICE_HOME: join(home, 'office') }), webDist: join(home, 'none'), claudeSkillsDir };
  ensureDirs(config);
  repoPath = join(home, 'app');
  execSync(`mkdir -p "${repoPath}" && cd "${repoPath}" && git init -q -b main && touch a && git add a && git -c user.name=t -c user.email=t@t commit -qm i`);
  const db = openDb(config.dbPath);
  const bus = new EventBus(db);
  const docs = new TaskDocs(config.tasksDir);
  const knowledge = new Knowledge(db, config.knowledgeDir);
  const graphs = new Graphs(config.graphsDir);
  pipeline = new Pipeline({
    knowledge,
    graphs,
    db,
    bus,
    config,
    agents: loadAgents(join(appDir, 'agents'), join(appDir, 'skills')),
    runner: idleRunner,
    publisher: {
      pushAndOpenDraftPr: async () => '',
      prState: async () => 'OPEN',
      prInfo: async () => { throw new Error('no'); },
      postReview: async () => '',
      reviewRequests: async () => [],
      login: async () => 'me',
      findReviewWithMarker: async () => null,
    },
    docs,
  });
  app = await buildServer({ db, bus, config, pipeline, docs, knowledge, graphs });
});

afterEach(async () => {
  await pipeline.shutdown();
  await app.close();
});

const headers = { host: '127.0.0.1:4100', 'x-office': '1' };

describe('server', () => {
  it('rejects writes without the x-office header (blocks cross-site form posts)', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/repos', headers: { host: '127.0.0.1:4100' }, payload: { name: 'x', path: repoPath } });
    expect(r.statusCode).toBe(403);
  });

  it('rejects other origins and other host names (CSRF, DNS rebinding)', async () => {
    const evilOrigin = await app.inject({ method: 'GET', url: '/api/tasks', headers: { ...headers, origin: 'https://evil.example' } });
    expect(evilOrigin.statusCode).toBe(403);
    const evilHost = await app.inject({ method: 'GET', url: '/api/tasks', headers: { host: 'evil.example:4100' } });
    expect(evilHost.statusCode).toBe(403);
  });

  it('adds a repo, creates a task and shows it on the board', async () => {
    const repo = await app.inject({ method: 'POST', url: '/api/repos', headers, payload: { name: 'app', path: repoPath, testCmd: 'npm test' } });
    expect(repo.statusCode).toBe(200);
    const repoId = repo.json().id;

    const bad = await app.inject({ method: 'POST', url: '/api/repos', headers, payload: { name: 'nope', path: '/definitely/not/here' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/does not exist/);

    const task = await app.inject({ method: 'POST', url: '/api/tasks', headers, payload: { repoId, input: 'Add a thing' } });
    expect(task.statusCode).toBe(200);
    expect(task.json().column).toBe('Queued');

    const list = await app.inject({ method: 'GET', url: '/api/tasks', headers });
    expect(list.json()).toHaveLength(1);

    const detail = await app.inject({ method: 'GET', url: `/api/tasks/${task.json().id}`, headers });
    expect(detail.json().repo.name).toBe('app');
  });

  it('saves a live check as verify.md and records it on the task', async () => {
    const repo = await app.inject({ method: 'POST', url: '/api/repos', headers, payload: { name: 'app', path: repoPath } });
    const task = await app.inject({ method: 'POST', url: '/api/tasks', headers, payload: { repoId: repo.json().id, input: 'Add a thing' } });
    const taskId = task.json().id;

    const bad = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/verification`, headers, payload: { verdict: 'great', report: 'x' } });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({ method: 'POST', url: '/api/tasks/999/verification', headers, payload: { verdict: 'pass', report: 'x' } });
    expect(missing.statusCode).toBe(400);

    const ok = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/verification`, headers, payload: { verdict: 'fail', report: 'Webhook returned 500.' } });
    expect(ok.statusCode).toBe(200);
    const doc = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}/docs/verify.md`, headers });
    expect(doc.body).toBe('---\nverdict: fail\nstage: build\n---\nWebhook returned 500.\n');
    const events = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}/events`, headers });
    expect(events.json().find((e: { type: string }) => e.type === 'verified').payload).toEqual({ verdict: 'fail', report: 'Webhook returned 500.', stage: 'build' });

    const deployed = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/verification`, headers, payload: { verdict: 'pass', report: 'Live.', stage: 'deployed', sha: '36d945d' } });
    expect(deployed.statusCode).toBe(200);
    const latest = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}/docs/verify.md`, headers });
    expect(latest.body).toBe('---\nverdict: pass\nstage: deployed\nsha: 36d945d\n---\nLive.\n');
    const badSha = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/verification`, headers, payload: { verdict: 'pass', report: 'x', sha: 'not-a-sha' } });
    expect(badSha.statusCode).toBe(400);
  });

  it('validates settings', async () => {
    const r = await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { concurrency: 99 } });
    expect(r.statusCode).toBe(400);
    const ok = await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { autoApprovePush: true, concurrency: 3 } });
    expect(ok.json()).toMatchObject({ autoApprovePush: true, concurrency: 3 });
  });

  it('rejects an empty review comment edit with a 400, not a 500', async () => {
    const r = await app.inject({ method: 'PUT', url: '/api/review-comments/1', headers, payload: {} });
    expect(r.statusCode).toBe(400);
  });

  it('edits an agent (validated), lists it as edited, and resets it', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/agents', headers });
    const coder = list.json().find((a: { role: string }) => a.role === 'coder');
    expect(coder.custom).toBe(false);

    const bad = await app.inject({ method: 'PUT', url: '/api/agents/coder', headers, payload: { text: coder.text.replace('tools: [', 'tools: [Agent, ') } });
    expect(bad.statusCode).toBe(400);
    const wrongName = await app.inject({ method: 'PUT', url: '/api/agents/tester', headers, payload: { text: coder.text } });
    expect(wrongName.json().error).toMatch(/name: coder/);

    const ok = await app.inject({ method: 'PUT', url: '/api/agents/coder', headers, payload: { text: coder.text.replace('effort: high', 'effort: max') } });
    expect(ok.statusCode).toBe(200);
    const after = (await app.inject({ method: 'GET', url: '/api/agents', headers })).json().find((a: { role: string }) => a.role === 'coder');
    expect(after).toMatchObject({ custom: true, effort: 'max' });

    await app.inject({ method: 'DELETE', url: '/api/agents/coder', headers });
    const reset = (await app.inject({ method: 'GET', url: '/api/agents', headers })).json().find((a: { role: string }) => a.role === 'coder');
    expect(reset).toMatchObject({ custom: false, effort: 'high' });
  });

  it('creates, lists and deletes my own skill', async () => {
    const text = '---\nname: our-style\ndescription: House style.\n---\nUse tabs.';
    expect((await app.inject({ method: 'PUT', url: '/api/skills/our-style', headers, payload: { text } })).statusCode).toBe(200);
    const skills = (await app.inject({ method: 'GET', url: '/api/skills', headers })).json();
    expect(skills.find((x: { name: string }) => x.name === 'our-style')).toMatchObject({ custom: true });
    expect(skills.find((x: { name: string }) => x.name === 'write-pr')).toMatchObject({ custom: false });
    expect((await app.inject({ method: 'PUT', url: '/api/skills/Bad Name', headers, payload: { text } })).statusCode).toBe(400);
    await app.inject({ method: 'DELETE', url: '/api/skills/our-style', headers });
    expect((await app.inject({ method: 'GET', url: '/api/skills', headers })).json().some((x: { name: string }) => x.name === 'our-style')).toBe(false);
  });

  it('refuses per-repo skills that do not exist or are not valid names', async () => {
    const unknown = await app.inject({ method: 'POST', url: '/api/repos', headers, payload: { name: 'app', path: repoPath, skills: { coder: ['nope'] } } });
    expect(unknown.json().error).toMatch(/Unknown skill\(s\): nope/);
    const traversal = await app.inject({ method: 'POST', url: '/api/repos', headers, payload: { name: 'app', path: repoPath, skills: { coder: ['../x'] } } });
    expect(traversal.statusCode).toBe(400);
    const badRole = await app.inject({ method: 'POST', url: '/api/repos', headers, payload: { name: 'app', path: repoPath, skills: { hacker: ['write-pr'] } } });
    expect(badRole.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/api/repos', headers, payload: { name: 'app', path: repoPath, skills: { coder: ['write-pr'] } } });
    expect(ok.statusCode).toBe(200);
  });

  it('installs a skill into the configured Claude skills folder once, never overwriting', async () => {
    const first = await app.inject({ method: 'POST', url: '/api/skills/write-pr/install-global', headers, payload: {} });
    expect(first.statusCode).toBe(200);
    expect(readFileSync(join(claudeSkillsDir, 'write-pr', 'SKILL.md'), 'utf8')).toContain('name: write-pr');
    const again = await app.inject({ method: 'POST', url: '/api/skills/write-pr/install-global', headers, payload: {} });
    expect(again.json().error).toMatch(/already exists/);
  });

  it('a skill used by a repo cannot be deleted', async () => {
    await app.inject({ method: 'PUT', url: '/api/skills/our-style', headers, payload: { text: '---\nname: our-style\ndescription: x\n---\nbody' } });
    await app.inject({ method: 'POST', url: '/api/repos', headers, payload: { name: 'app', path: repoPath, skills: { coder: ['our-style'] } } });
    const del = await app.inject({ method: 'DELETE', url: '/api/skills/our-style', headers });
    expect(del.json().error).toMatch(/Used by: repo app/);
  });

  it('saves a knowledge file and enforces its size cap', async () => {
    const repo = (await app.inject({ method: 'POST', url: '/api/repos', headers, payload: { name: 'app', path: repoPath } })).json();
    expect((await app.inject({ method: 'PUT', url: `/api/repos/${repo.id}/knowledge`, headers, payload: { text: '# Notes\n- one' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/repos/${repo.id}/knowledge`, headers })).json().text).toContain('- one');
    const tooLong = Array.from({ length: 200 }, (_, i) => `- ${i}`).join('\n');
    expect((await app.inject({ method: 'PUT', url: `/api/repos/${repo.id}/knowledge`, headers, payload: { text: tooLong } })).statusCode).toBe(400);
  });

  it('reports the usage pause in settings', async () => {
    const r = await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { usagePauseAt: 0.8 } });
    expect(r.json().usagePauseAt).toBe(0.8);
    expect((await app.inject({ method: 'GET', url: '/api/settings', headers })).json().usage).toMatchObject({ paused: false });
  });

  it('refuses document paths that escape the task folder', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/tasks/1/docs/..%2F..%2Fenv', headers });
    expect(r.statusCode).toBe(404);
  });
});

describe('attachments', () => {
  it('uploads a file, attaches it to a new task, and serves it back safely', async () => {
    const repo = (await app.inject({ method: 'POST', url: '/api/repos', headers, payload: { name: 'app', path: repoPath } })).json() as { id: number };
    const up = await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { ...headers, 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent('Mock up.png') },
      payload: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    expect(up.statusCode).toBe(200);
    const { id: uploadId, name } = up.json() as { id: string; name: string };
    expect(name).toBe('Mock-up.png');
    const created = await app.inject({ method: 'POST', url: '/api/tasks', headers, payload: { repoId: repo.id, input: 'Match the mock-up', attachments: [uploadId], links: ['https://figma.com/file/x'] } });
    expect(created.statusCode).toBe(200);
    const task = created.json() as { id: number; attachments: Array<{ name: string }>; links: string[] };
    expect(task.attachments.map((a) => a.name)).toEqual(['Mock-up.png']);
    expect(task.links).toEqual(['https://figma.com/file/x']);
    const file = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/attachments/Mock-up.png`, headers });
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['content-security-policy']).toContain('sandbox');
    expect((await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/attachments/..%2Fplan.md`, headers })).statusCode).toBe(404);
    // Uploads need the x-office header like every other change.
    const csrf = await app.inject({ method: 'POST', url: '/api/uploads', headers: { host: '127.0.0.1:4100', 'content-type': 'application/octet-stream', 'x-filename': 'a.md' }, payload: 'x' });
    expect(csrf.statusCode).toBe(403);
    // Other routes don't take raw bodies.
    const raw = await app.inject({ method: 'POST', url: '/api/tasks', headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: 'x' });
    expect(raw.statusCode).toBe(415);
    // An expired upload refuses the task instead of creating it without its files.
    const before = (await app.inject({ method: 'GET', url: '/api/tasks', headers })).json() as unknown[];
    const expired = await app.inject({ method: 'POST', url: '/api/tasks', headers, payload: { repoId: repo.id, input: 'x', attachments: ['0'.repeat(24)] } });
    expect(expired.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/tasks', headers })).json()).toHaveLength(before.length);
  });
});
