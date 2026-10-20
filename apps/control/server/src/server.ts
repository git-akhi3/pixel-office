import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { OfficeConfig } from './config.js';
import { getSettings, schema, setSetting, usagePause, type Db } from './db/index.js';
import { boardColumn, ROLES, TASK_STATUSES } from './domain.js';
import { attachmentsDir, MAX_ATTACHMENT_BYTES, servedAs, Uploads } from './attachments.js';
import { isWrapperSkill, listSkills, loadAgents, parseAgent, parseSkill, SKILL_NAME } from './agents.js';
import { PICKABLE_ROLES } from './prompts.js';
import { readSourceInfo, SkillImporter, updateAvailable } from './skillImport.js';
import { GRAPHIFY_INSTALL } from './graph.js';
import { MAX_KNOWLEDGE_LINES } from './knowledge.js';
import type { EventBus } from './events.js';
import type { TaskDocs } from './handoffs.js';
import type { Graphs } from './graph.js';
import type { Knowledge } from './knowledge.js';
import type { Pipeline } from './pipeline.js';
import type { PixelBridge } from './pixelBridge.js';
import { PICKABLE_LANES } from './lanes.js';
import { createRepo, deleteRepo, effectiveAllowlist, getRepo, ghAccounts, listRepos, updateRepo } from './repos.js';
import { run } from './util/exec.js';
import { diff } from './worktree.js';

export interface ServerDeps {
  db: Db;
  bus: EventBus;
  config: OfficeConfig;
  pipeline: Pipeline;
  docs: TaskDocs;
  knowledge: Knowledge;
  graphs: Graphs;
  pixel?: () => PixelBridge;
  uploads?: Uploads;
}

const id = z.coerce.number().int().positive();

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { db, bus, config, pipeline, docs, knowledge, graphs } = deps;
  const app = Fastify({ logger: { level: process.env.OFFICE_LOG ?? 'warn' }, forceCloseConnections: true });
  // Local only. Remote hostnames come with phase 2, together with Cloudflare Access verification:
  // accepting a tunnel hostname without checking Access would expose a machine that runs agents.
  const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);
  const devHosts = new Set(['127.0.0.1:5173', 'localhost:5173']);
  const devOrigins = new Set([...devHosts].map((h) => `http://${h}`));

  // The API can run agents on this machine: refuse other sites (CSRF) and other hostnames (DNS rebinding).
  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host ?? '';
    if (!allowedHosts.has(host) && !devHosts.has(host)) return reply.code(403).send({ error: 'host not allowed' });
    const origin = req.headers.origin;
    if (origin && !devOrigins.has(origin) && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) {
      return reply.code(403).send({ error: 'origin not allowed' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-office'] !== '1') {
      return reply.code(403).send({ error: 'missing x-office header' });
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err instanceof z.ZodError ? 400 : (err.statusCode ?? 400);
    const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : err.message;
    reply.code(status >= 500 ? 500 : status).send({ error: message });
  });

  await app.register(fastifyWebsocket);

  // ---------------------------------------------------------------- repos

  app.get('/api/repos', async () => listRepos(db).map((r) => ({ ...r, effectiveAllowlist: effectiveAllowlist(r) })));
  /** Per-repo skills must exist, so a typo can't block every step of that repo later. */
  const checkRepoSkills = (body: unknown) => {
    const skills = (body as { skills?: Record<string, string[]> } | null)?.skills ?? {};
    const known = new Set(listSkills([config.customSkillsDir, config.skillsDir]).map((s) => s.name));
    const missing = Object.values(skills).flat().filter((n) => !known.has(n));
    if (missing.length) throw new Error(`Unknown skill(s): ${[...new Set(missing)].join(', ')}. Create them on the Team page first.`);
  };
  app.post('/api/repos', async (req) => {
    checkRepoSkills(req.body);
    const repo = await createRepo(db, req.body as never);
    if (repo.graphify) pipeline.refreshGraph(repo.id);
    return repo;
  });
  app.put('/api/repos/:id', async (req) => {
    const repoId = id.parse((req.params as { id: string }).id);
    const before = getRepo(db, repoId);
    checkRepoSkills(req.body);
    const repo = await updateRepo(db, repoId, req.body as never);
    if (repo.graphify && !before.graphify) pipeline.refreshGraph(repo.id); // turning the graph on builds it
    return repo;
  });
  app.delete('/api/repos/:id', async (req) => {
    deleteRepo(db, id.parse((req.params as { id: string }).id));
    return { ok: true };
  });
  app.get('/api/gh-accounts', async () => ghAccounts());

  // ---------------------------------------------------------------- tasks

  const summary = (t: typeof schema.tasks.$inferSelect) => ({
    ...t,
    column: boardColumn(t.status),
    running: pipeline.isRunning(t.id),
    tokens: pipeline.tokensUsed(t.id),
    pendingGates: pipeline.pendingGates(t.id).map((g) => ({ id: g.id, kind: g.kind, subject: g.subject })),
  });

  app.get('/api/tasks', async () => db.select().from(schema.tasks).orderBy(desc(schema.tasks.updatedAt)).all().map(summary));

  app.post('/api/tasks', async (req) => {
    const body = z
      .object({
        repoId: id,
        input: z.string().min(1).max(20_000),
        kind: z.enum(['feature', 'bug']).optional(),
        title: z.string().max(80).optional(),
        skills: z.partialRecord(z.enum(PICKABLE_ROLES as [string, ...string[]]), z.array(z.string().regex(SKILL_NAME)).max(10)).optional(),
        grillMode: z.enum(['auto', 'always', 'never']).optional(),
        attachments: z.array(z.string().regex(/^[0-9a-f]{24}$/)).max(10).optional(),
        links: z.array(z.string().max(2000)).max(10).optional(),
        refRepos: z.array(id).max(10).optional(),
        lane: z.enum(PICKABLE_LANES).optional(),
      })
      .parse(req.body);
    return summary(pipeline.createTask(body));
  });

  app.get('/api/tasks/:id', async (req) => {
    const taskId = id.parse((req.params as { id: string }).id);
    const task = pipeline.getTask(taskId);
    const repo = getRepo(db, task.repoId);
    return {
      task: summary(task),
      repo: { id: repo.id, name: repo.name, defaultBranch: repo.defaultBranch },
      refs: listRepos(db)
        .filter((r) => task.refRepos.includes(r.id))
        .map((r) => ({ id: r.id, name: r.name })),
      runs: db.select().from(schema.runs).where(eq(schema.runs.taskId, taskId)).all(),
      gates: db.select().from(schema.gates).where(eq(schema.gates.taskId, taskId)).all(),
      docs: docs.list(taskId),
      reviewComments: task.kind === 'review' ? pipeline.reviewComments(taskId) : [],
      questions: pipeline.questions(taskId),
      // Epics: the milestone tasks it was split into; milestones: the epic.
      milestones: db
        .select({ id: schema.tasks.id, title: schema.tasks.title, status: schema.tasks.status, dependsOn: schema.tasks.dependsOn })
        .from(schema.tasks)
        .where(eq(schema.tasks.parentId, taskId))
        .orderBy(asc(schema.tasks.id))
        .all(),
      parent: task.parentId ? (({ id, title, status }) => ({ id, title, status }))(pipeline.getTask(task.parentId)) : null,
      alerts: db
        .select()
        .from(schema.events)
        .where(and(eq(schema.events.taskId, taskId), eq(schema.events.type, 'alert')))
        .all(),
    };
  });

  // ---------------------------------------------------------------- attachments

  const uploads = deps.uploads ?? new Uploads(config.uploadsDir);
  // Files arrive as raw bytes; the name comes in a header (URI-encoded). The raw parser and the
  // large body limit apply to this route only (the host and x-office checks above still run).
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_ATTACHMENT_BYTES + 1024 }, (_req, body, done) => done(null, body));
    scope.post('/api/uploads', { bodyLimit: MAX_ATTACHMENT_BYTES + 1024 }, async (req) => {
      if (!String(req.headers['content-type'] ?? '').startsWith('application/octet-stream')) throw new Error('Send the file as application/octet-stream.');
      const raw = req.headers['x-filename'];
      let name = '';
      try {
        name = typeof raw === 'string' ? decodeURIComponent(raw) : '';
      } catch {
        throw new Error('The file name is not valid.');
      }
      if (!name) throw new Error('Missing the file name (x-filename).');
      if (!Buffer.isBuffer(req.body)) throw new Error('Send the file as application/octet-stream.');
      return uploads.save(name, req.body);
    });
  });

  app.get('/api/tasks/:id/attachments/:name', async (req, reply) => {
    const p = req.params as { id: string; name: string };
    const task = pipeline.getTask(id.parse(p.id));
    const a = task.attachments.find((x) => x.name === p.name);
    if (!a) return reply.code(404).send({ error: 'no such attachment' });
    const file = join(attachmentsDir(docs.dir(task.id)), a.name);
    if (!existsSync(file)) return reply.code(404).send({ error: 'the file is gone' });
    const { type, inline } = servedAs(a.name);
    return reply
      .type(type)
      .header('x-content-type-options', 'nosniff')
      // Sandboxed, so an attachment can never run script on the board's origin (a PDF needs the viewer, which sandbox blocks).
      .header('content-security-policy', type === 'application/pdf' ? "default-src 'none'; object-src 'self'" : "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox")
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${a.name}"`)
      .send(readFileSync(file));
  });

  app.get('/api/tasks/:id/docs/:file', async (req, reply) => {
    const p = req.params as { id: string; file: string };
    const text = docs.read(id.parse(p.id), p.file);
    if (text === null) return reply.code(404).send({ error: 'no such document' });
    return reply.type('text/markdown; charset=utf-8').send(text);
  });

  app.get('/api/tasks/:id/diff', async (req, reply) => {
    const task = pipeline.getTask(id.parse((req.params as { id: string }).id));
    if (!task.worktreePath || !task.baseSha || !existsSync(task.worktreePath)) return reply.type('text/plain').send('');
    return reply.type('text/plain; charset=utf-8').send(await diff(task.worktreePath, task.baseSha));
  });

  app.get('/api/tasks/:id/events', async (req) => {
    const taskId = id.parse((req.params as { id: string }).id);
    const q = z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(2000).default(500) }).parse(req.query);
    return db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.taskId, taskId), gt(schema.events.id, q.after)))
      .orderBy(schema.events.id)
      .limit(q.limit)
      .all();
  });

  app.post('/api/gates/:id', async (req) => {
    const body = z
      .object({ decision: z.enum(['approve', 'reject', 'allow_once', 'allow_always', 'deny']), comment: z.string().max(10_000).optional() })
      .parse(req.body);
    await pipeline.decideGate(id.parse((req.params as { id: string }).id), body.decision, body.comment);
    return { ok: true };
  });

  app.post('/api/tasks/:id/actions', async (req) => {
    const taskId = id.parse((req.params as { id: string }).id);
    const { action } = z.object({ action: z.enum(['stop', 'resume', 'discard', 'done', 'takeover']) }).parse(req.body);
    if (action === 'takeover') {
      const task = pipeline.getTask(taskId);
      if (!task.worktreePath || !existsSync(task.worktreePath)) throw new Error('This task has no worktree.');
      const editor = await run('code', [task.worktreePath]);
      if (editor.code !== 0) await run('open', [task.worktreePath]);
      return { ok: true, path: task.worktreePath };
    }
    return summary(await pipeline.action(taskId, action));
  });

  app.post('/api/questions/:id', async (req) => {
    const body = z
      .object({ answer: z.string().trim().min(1).max(4000).optional(), delegate: z.boolean().optional() })
      .refine((b) => !!b.answer !== !!b.delegate, 'Send an answer or delegate: true.')
      .parse(req.body);
    return pipeline.answerQuestion(id.parse((req.params as { id: string }).id), { text: body.answer, delegate: body.delegate }, 'board');
  });

  app.post('/api/tasks/:id/briefing', async (req) => {
    const { action } = z.object({ action: z.enum(['send', 'enough']) }).parse(req.body);
    pipeline.briefingAction(id.parse((req.params as { id: string }).id), action);
    return { ok: true };
  });

  app.put('/api/tasks/:id/skills', async (req) => {
    const body = z.object({ role: z.enum(PICKABLE_ROLES as [string, ...string[]]), skills: z.array(z.string().regex(SKILL_NAME)).max(10) }).parse(req.body);
    return summary(pipeline.setTaskSkills(id.parse((req.params as { id: string }).id), body.role as (typeof ROLES)[number], body.skills));
  });

  app.post('/api/tasks/:id/steer', async (req) => {
    const { text } = z.object({ text: z.string().trim().min(1).max(4000) }).parse(req.body);
    return { delivered: pipeline.steer(id.parse((req.params as { id: string }).id), text) };
  });

  // A live check from the desktop verifier (real APIs, logs, devices): kept as verify.md and posted to the task's thread.
  // stage: before the merge (build), on new commits to the open PR (pr), on staging after the deploy (staging, normally
  // the office's own verifier), or once the merge is live in production (deployed).
  app.post('/api/tasks/:id/verification', async (req) => {
    const taskId = id.parse((req.params as { id: string }).id);
    const { verdict, report, stage, sha } = z
      .object({
        verdict: z.enum(['pass', 'fail', 'partial']),
        report: z.string().trim().min(1).max(20_000),
        stage: z.enum(['build', 'pr', 'staging', 'deployed']).default('build'),
        sha: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
      })
      .parse(req.body);
    pipeline.getTask(taskId);
    docs.save(taskId, 'verify', `---\nverdict: ${verdict}\nstage: ${stage}\n${sha ? `sha: ${sha}\n` : ''}---\n${report}\n`);
    bus.emit(taskId, 'verified', { verdict, report, stage, ...(sha ? { sha } : {}) });
    return { ok: true };
  });

  app.post('/api/tasks/:id/replan', async (req) => {
    const { reason } = z.object({ reason: z.string().trim().min(1).max(4000) }).parse(req.body);
    return summary(pipeline.replanNow(id.parse((req.params as { id: string }).id), reason));
  });

  // ---------------------------------------------------------------- reviews

  app.post('/api/reviews', async (req) => {
    const { prUrl } = z.object({ prUrl: z.string().trim().url() }).parse(req.body);
    return summary(await pipeline.createReviewTask(prUrl));
  });

  app.post('/api/reviews/pickup', async () => ({ created: await pipeline.pickUpReviews() }));

  app.put('/api/review-comments/:id', async (req) => {
    const patch = z
      .object({ body: z.string().trim().min(1).max(10_000).optional(), deleted: z.boolean().optional() })
      .refine((p) => p.body !== undefined || p.deleted !== undefined, 'Send body or deleted.')
      .parse(req.body);
    return pipeline.editReviewComment(id.parse((req.params as { id: string }).id), patch);
  });

  app.put('/api/tasks/:id/review-summary', async (req) => {
    const { summary: text } = z.object({ summary: z.string().max(20_000) }).parse(req.body);
    return summary(pipeline.editReviewSummary(id.parse((req.params as { id: string }).id), text));
  });

  app.post('/api/tasks/:id/fix-it', async (req) => summary(await pipeline.fixIt(id.parse((req.params as { id: string }).id))));

  // ---------------------------------------------------------------- knowledge files

  app.get('/api/repos/:id/knowledge', async (req) => {
    const repoId = id.parse((req.params as { id: string }).id);
    getRepo(db, repoId);
    return { text: knowledge.read(repoId), maxLines: MAX_KNOWLEDGE_LINES, proposals: knowledge.proposals('pending', repoId) };
  });
  app.put('/api/repos/:id/knowledge', async (req) => {
    const repoId = id.parse((req.params as { id: string }).id);
    getRepo(db, repoId);
    knowledge.write(repoId, z.object({ text: z.string().max(50_000) }).parse(req.body).text);
    return { ok: true };
  });
  app.get('/api/knowledge/proposals', async () => knowledge.proposals('pending'));
  app.post('/api/knowledge/proposals/:id', async (req) => {
    const body = z.object({ decision: z.enum(['accept', 'reject']), text: z.string().trim().min(1).max(2000).optional() }).parse(req.body);
    return knowledge.decide(id.parse((req.params as { id: string }).id), body.decision, body.text);
  });

  // ---------------------------------------------------------------- agents and skills

  const agentDirs = [config.customAgentsDir, config.agentsDir];
  const skillDirs = [config.customSkillsDir, config.skillsDir];
  const reloadAgents = () => pipeline.setAgents(loadAgents(agentDirs, skillDirs, (m) => app.log.warn(m)));
  const role = z.enum(ROLES);

  app.get('/api/agents', async () =>
    ROLES.map((r) => {
      const custom = join(config.customAgentsDir, `${r}.md`);
      const file = existsSync(custom) ? custom : join(config.agentsDir, `${r}.md`);
      const text = readFileSync(file, 'utf8');
      try {
        const def = parseAgent(text, file, skillDirs);
        return { role: r, custom: existsSync(custom), text, model: def.model, effort: def.effort, tools: def.tools, skills: def.skills, description: def.description };
      } catch (e) {
        // A broken custom file: show it so it can be fixed or reset (the built-in one is in use).
        return { role: r, custom: true, text, model: '?', tools: [], skills: [], description: '', error: (e as Error).message };
      }
    }),
  );
  app.put('/api/agents/:role', async (req) => {
    const r = role.parse((req.params as { role: string }).role);
    const { text } = z.object({ text: z.string().min(1).max(50_000) }).parse(req.body);
    const def = parseAgent(text, `${r}.md`, skillDirs); // validates; throws a readable error
    if (def.name !== r) throw new Error(`The file says name: ${def.name}, but this is the ${r} agent.`);
    mkdirSync(config.customAgentsDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(config.customAgentsDir, `${r}.md`), text);
    reloadAgents();
    return { ok: true };
  });
  app.delete('/api/agents/:role', async (req) => {
    rmSync(join(config.customAgentsDir, `${role.parse((req.params as { role: string }).role)}.md`), { force: true });
    reloadAgents();
    return { ok: true };
  });

  app.get('/api/skills', async () =>
    listSkills(skillDirs).map((s) => {
      const custom = s.source === config.customSkillsDir;
      const source = custom ? readSourceInfo(config.customSkillsDir, s.name) : null;
      return {
        name: s.name,
        description: s.description,
        text: s.text,
        custom,
        builtIn: existsSync(join(config.skillsDir, s.name, 'SKILL.md')),
        wrapper: isWrapperSkill(s.body),
        importedFrom: source?.source ?? null,
        updateAvailable: custom && updateAvailable(config.customSkillsDir, s.name),
      };
    }),
  );

  // Importing from Claude Code: only skills the importer found can be read or copied.
  const importer = new SkillImporter(config.importRoots, config.customSkillsDir, () => new Set(listSkills(skillDirs).map((s) => s.name)));
  const importKey = z.object({ key: z.string().regex(/^[0-9a-f]{16}$/) });
  app.get('/api/skills/importable', async () => importer.list());
  app.get('/api/skills/importable/:key', async (req) => importer.diff(importKey.parse(req.params).key));
  app.post('/api/skills/import', async (req) => {
    const result = importer.import(importKey.parse(req.body).key);
    reloadAgents();
    return result;
  });
  app.put('/api/skills/:name', async (req) => {
    const name = z.string().regex(SKILL_NAME).parse((req.params as { name: string }).name);
    const { text } = z.object({ text: z.string().min(1).max(50_000) }).parse(req.body);
    const skill = parseSkill(text, `${name}/SKILL.md`);
    if (skill.name !== name) throw new Error(`The file says name: ${skill.name}, but the skill is ${name}.`);
    mkdirSync(join(config.customSkillsDir, name), { recursive: true, mode: 0o700 });
    writeFileSync(join(config.customSkillsDir, name, 'SKILL.md'), text);
    reloadAgents();
    return { ok: true };
  });
  app.delete('/api/skills/:name', async (req) => {
    const name = z.string().regex(SKILL_NAME).parse((req.params as { name: string }).name);
    const builtIn = existsSync(join(config.skillsDir, name, 'SKILL.md'));
    if (!builtIn) {
      const byAgents = ROLES.filter((r) => pipeline.agentSkills(r).includes(name));
      const byRepos = listRepos(db).filter((repo) => Object.values(repo.skills).some((list) => list.includes(name)));
      const users = [...byAgents, ...byRepos.map((r) => `repo ${r.name}`)];
      if (users.length) throw new Error(`Used by: ${users.join(', ')}. Remove it there first.`);
    }
    rmSync(join(config.customSkillsDir, name), { recursive: true, force: true });
    reloadAgents();
    return { ok: true };
  });
  /** Optional: also make a skill available to my everyday Claude Code sessions (~/.claude/skills). */
  app.post('/api/skills/:name/install-global', async (req) => {
    const name = z.string().regex(SKILL_NAME).parse((req.params as { name: string }).name);
    const skill = listSkills(skillDirs).find((s) => s.name === name);
    if (!skill) throw new Error(`Unknown skill ${name}`);
    const dest = join(config.claudeSkillsDir, name);
    if (existsSync(join(dest, 'SKILL.md'))) throw new Error(`${dest} already exists; not overwriting it.`);
    mkdirSync(dest, { recursive: true, mode: 0o700 });
    writeFileSync(join(dest, 'SKILL.md'), skill.text);
    return { ok: true, path: dest };
  });

  // ---------------------------------------------------------------- code graph

  app.get('/api/graphify', async () => {
    const status = await graphs.status();
    const repos = listRepos(db).map((r) => ({ repoId: r.id, enabled: r.graphify, builtAt: graphs.builtAt(r.id), building: graphs.isBuilding(r.id), ...pipeline.graphTokenStats(r.id) }));
    return { ...status, repos };
  });
  app.post('/api/repos/:id/graph', async (req) => {
    const repo = getRepo(db, id.parse((req.params as { id: string }).id));
    if (!(await graphs.status()).installed) throw new Error(`Graphify isn't installed. Run: ${GRAPHIFY_INSTALL}`);
    if (graphs.isBuilding(repo.id)) return { building: true };
    // Builds can take minutes: start it and report progress through GET /api/graphify.
    void graphs.build(repo).then(
      () => bus.emit(null, 'graph_built', { repoId: repo.id }),
      (e: unknown) => bus.emit(null, 'graph_failed', { repoId: repo.id, error: e instanceof Error ? e.message : String(e) }),
    );
    return { building: true };
  });

  // ---------------------------------------------------------------- office tab

  /** Where the pixel office is (if running) and whether office agents will show up in it. */
  app.get('/api/office', async () => {
    const bridge = deps.pixel?.();
    const server = bridge?.server() ?? null;
    return {
      running: !!server,
      url: server ? `http://127.0.0.1:${server.port}/` : null,
      linked: !!bridge?.workspace(),
      aspect: bridge?.layoutAspect() ?? null,
      start: 'npm run pixel',
    };
  });

  // ---------------------------------------------------------------- settings

  app.get('/api/settings', async () => {
    const s = getSettings(db);
    return { ...s, usage: usagePause(s, Date.now()), statuses: TASK_STATUSES };
  });
  app.put('/api/settings', async (req) => {
    const body = z
      .object({
        concurrency: z.number().int().min(1).max(6).optional(),
        reviewAutoPickup: z.boolean().optional(),
        reviewMinLines: z.number().int().min(0).max(100_000).optional(),
        usagePauseAt: z.number().min(0.5).max(1).optional(),
        grillSkill: z.string().regex(SKILL_NAME).optional(),
        sonnetForSmall: z.boolean().optional(),
        plansWaitForMe: z.boolean().optional(),
        autoAllowCommands: z.boolean().optional(),
      })
      .parse(req.body);
    if (body.grillSkill !== undefined) setSetting(db, 'grillSkill', body.grillSkill);
    if (body.concurrency !== undefined) setSetting(db, 'concurrency', body.concurrency);
    if (body.reviewAutoPickup !== undefined) setSetting(db, 'reviewAutoPickup', body.reviewAutoPickup);
    if (body.reviewMinLines !== undefined) setSetting(db, 'reviewMinLines', body.reviewMinLines);
    if (body.usagePauseAt !== undefined) setSetting(db, 'usagePauseAt', body.usagePauseAt);
    if (body.sonnetForSmall !== undefined) setSetting(db, 'sonnetForSmall', body.sonnetForSmall);
    if (body.plansWaitForMe !== undefined) setSetting(db, 'plansWaitForMe', body.plansWaitForMe);
    if (body.autoAllowCommands !== undefined) setSetting(db, 'autoAllowCommands', body.autoAllowCommands);
    void pipeline.tick();
    return getSettings(db);
  });

  app.get('/api/health', async () => ({ ok: true }));

  // ---------------------------------------------------------------- live updates

  app.get('/ws', { websocket: true }, (socket) => {
    const unsubscribe = bus.subscribe((msg) => {
      const payload = msg.type === 'task' ? { type: 'task', task: summary(msg.task) } : msg;
      socket.send(JSON.stringify(payload));
    });
    socket.on('close', unsubscribe);
  });

  // ---------------------------------------------------------------- board

  if (existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html'),
    );
  }

  return app;
}
