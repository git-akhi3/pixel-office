import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { GateKind, GateStatus, Role, TaskKind, TaskSize, TaskStatus } from '../domain.js';

const now = () => Date.now();

export const repos = sqliteTable('repos', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  path: text('path').notNull(),
  defaultBranch: text('default_branch').notNull().default('main'),
  protectedBranches: text('protected_branches', { mode: 'json' }).$type<string[]>().notNull().default([]),
  /** Run by the office (not an agent) in each new worktree, e.g. npm ci or linking a venv. $REPO_PATH is the main checkout. */
  setupCmd: text('setup_cmd'),
  buildCmd: text('build_cmd'),
  testCmd: text('test_cmd'),
  lintCmd: text('lint_cmd'),
  /** Glob-ish patterns the tester may write, e.g. "**\/*.test.ts". */
  testGlobs: text('test_globs', { mode: 'json' }).$type<string[]>().notNull().default([]),
  ghAccount: text('gh_account'),
  gitAuthor: text('git_author'), // "Name <email>" used for office commits when the repo has none
  allowlist: text('allowlist', { mode: 'json' }).$type<string[]>().notNull().default([]),
  createdAt: integer('created_at').notNull().$defaultFn(now),
});

export const tasks = sqliteTable('tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  repoId: integer('repo_id')
    .notNull()
    .references(() => repos.id),
  title: text('title').notNull(),
  input: text('input').notNull(),
  kind: text('kind').$type<TaskKind>().notNull().default('feature'),
  size: text('size').$type<TaskSize>(),
  needsDebugger: integer('needs_debugger', { mode: 'boolean' }).notNull().default(false),
  needsResearcher: integer('needs_researcher', { mode: 'boolean' }).notNull().default(false),
  designFlag: integer('design_flag', { mode: 'boolean' }).notNull().default(false),
  status: text('status').$type<TaskStatus>().notNull().default('queued'),
  /** Where `resume` continues from (paused, stopped, blocked). */
  resumeStatus: text('resume_status').$type<TaskStatus>(),
  statusNote: text('status_note'),
  /** Feedback for the next agent step (my rejection comment, a blocker, failing reports). Cleared when that step starts. */
  feedback: text('feedback'),
  loopCount: integer('loop_count').notNull().default(0),
  replanCount: integer('replan_count').notNull().default(0),
  testFailures: integer('test_failures').notNull().default(0),
  tokenEstimate: integer('token_estimate'),
  filesInScope: text('files_in_scope', { mode: 'json' }).$type<string[]>().notNull().default([]),
  branch: text('branch'),
  baseSha: text('base_sha'),
  worktreePath: text('worktree_path'),
  prUrl: text('pr_url'),
  resumeAt: integer('resume_at'),
  doneAt: integer('done_at'),
  createdAt: integer('created_at').notNull().$defaultFn(now),
  updatedAt: integer('updated_at').notNull().$defaultFn(now),
});

export const runs = sqliteTable('runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  taskId: integer('task_id')
    .notNull()
    .references(() => tasks.id),
  role: text('role').$type<Role>().notNull(),
  step: text('step').$type<TaskStatus>().notNull(),
  model: text('model').notNull(),
  effort: text('effort'),
  sessionId: text('session_id'),
  status: text('status').$type<'running' | 'ok' | 'failed' | 'interrupted' | 'rate_limited'>().notNull(),
  error: text('error'),
  doc: text('doc'),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
  thinkingTokens: integer('thinking_tokens').notNull().default(0),
  durationMs: integer('duration_ms'),
  startedAt: integer('started_at').notNull().$defaultFn(now),
  endedAt: integer('ended_at'),
});

export const gates = sqliteTable('gates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  taskId: integer('task_id')
    .notNull()
    .references(() => tasks.id),
  kind: text('kind').$type<GateKind>().notNull(),
  status: text('status').$type<GateStatus>().notNull().default('pending'),
  /** For command gates: the command or tool call waiting for a decision. */
  subject: text('subject'),
  decision: text('decision'),
  comment: text('comment'),
  auto: integer('auto', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull().$defaultFn(now),
  decidedAt: integer('decided_at'),
});

export const events = sqliteTable('events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  taskId: integer('task_id').references(() => tasks.id),
  runId: integer('run_id'),
  type: text('type').notNull(),
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  at: integer('at').notNull().$defaultFn(now),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
});

export type Repo = typeof repos.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type Gate = typeof gates.$inferSelect;
export type OfficeEvent = typeof events.$inferSelect;
