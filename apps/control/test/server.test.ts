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
  pipeline = new Pipeline({
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
    },
    docs,
  });
  app = await buildServer({ db, bus, config, pipeline, docs });
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

  it('refuses document paths that escape the task folder', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/tasks/1/docs/..%2F..%2Fenv', headers });
    expect(r.statusCode).toBe(404);
  });
});
