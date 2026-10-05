import { execSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
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

const idleRunner: AgentRunner = {
  run: (req) => new Promise((res) => req.signal.addEventListener('abort', () => res({ status: 'interrupted', text: '', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 }, durationMs: 0 }))),
  steer: () => false,
};

beforeEach(async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'office-srv-')));
  const config = { ...loadConfig({ OFFICE_HOME: join(home, 'office') }), webDist: join(home, 'none') };
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
