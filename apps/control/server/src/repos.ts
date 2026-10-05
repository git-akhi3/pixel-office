import { eq } from 'drizzle-orm';
import { existsSync, realpathSync } from 'node:fs';
import { z } from 'zod';
import type { Db } from './db/index.js';
import { schema } from './db/index.js';
import type { Repo } from './db/schema.js';
import { run } from './util/exec.js';

/** Read-only commands every repo allows, on top of its own build/test/lint commands. */
export const BASE_ALLOWLIST = [
  'git status',
  'git diff',
  'git log',
  'git show',
  'git ls-files',
  'git grep',
  'git rev-parse',
  'git blame',
  'git branch --show-current',
  'ls',
  'pwd',
  'cat',
  'head',
  'tail',
  'wc',
  'rg',
  'grep',
  'which',
];

export const repoInput = z.object({
  name: z.string().trim().min(1).max(80),
  path: z.string().trim().min(1),
  defaultBranch: z.string().trim().min(1).default('main'),
  protectedBranches: z.array(z.string().trim().min(1)).default([]),
  buildCmd: z.string().trim().nullish(),
  testCmd: z.string().trim().nullish(),
  lintCmd: z.string().trim().nullish(),
  testGlobs: z.array(z.string().trim().min(1)).default(['**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/__tests__/**']),
  ghAccount: z.string().trim().nullish(),
  gitAuthor: z
    .string()
    .trim()
    .regex(/^[^<>]+ <[^<>@\s]+@[^<>\s]+>$/, 'use "Name <email>"')
    .nullish(),
  allowlist: z.array(z.string().trim().min(1)).default([]),
});
export type RepoInput = z.input<typeof repoInput>;

export async function validateRepoPath(path: string): Promise<string> {
  if (!existsSync(path)) throw new Error(`Path does not exist: ${path}`);
  const real = realpathSync(path);
  const r = await run('git', ['rev-parse', '--show-toplevel'], { cwd: real });
  if (r.code !== 0) throw new Error(`Not a git repository: ${path}`);
  if (realpathSync(r.stdout.trim()) !== real) throw new Error(`Use the repository root: ${r.stdout.trim()}`);
  return real;
}

export function listRepos(db: Db): Repo[] {
  return db.select().from(schema.repos).all();
}

export function getRepo(db: Db, id: number): Repo {
  const repo = db.select().from(schema.repos).where(eq(schema.repos.id, id)).get();
  if (!repo) throw new Error(`No repo ${id}`);
  return repo;
}

export async function createRepo(db: Db, input: RepoInput): Promise<Repo> {
  const data = repoInput.parse(input);
  const path = await validateRepoPath(data.path);
  return db
    .insert(schema.repos)
    .values({ ...data, path })
    .returning()
    .get();
}

export async function updateRepo(db: Db, id: number, input: RepoInput): Promise<Repo> {
  getRepo(db, id);
  const data = repoInput.parse(input);
  const path = await validateRepoPath(data.path);
  return db
    .update(schema.repos)
    .set({ ...data, path })
    .where(eq(schema.repos.id, id))
    .returning()
    .get();
}

export function deleteRepo(db: Db, id: number): void {
  const hasTasks = db.select().from(schema.tasks).where(eq(schema.tasks.repoId, id)).get();
  if (hasTasks) throw new Error('This repo has tasks; it cannot be removed.');
  db.delete(schema.repos).where(eq(schema.repos.id, id)).run();
}

export function addToAllowlist(db: Db, repo: Repo, command: string): Repo {
  if (repo.allowlist.includes(command)) return repo;
  return db
    .update(schema.repos)
    .set({ allowlist: [...repo.allowlist, command] })
    .where(eq(schema.repos.id, repo.id))
    .returning()
    .get();
}

/** The full allow-list for a repo: base read-only commands, its configured commands, and what I approved. */
export function effectiveAllowlist(repo: Repo): string[] {
  const own = [repo.buildCmd, repo.testCmd, repo.lintCmd].filter((c): c is string => !!c);
  return [...new Set([...BASE_ALLOWLIST, ...own, ...repo.allowlist])];
}

/** Accounts logged in to `gh`, e.g. ["akhilxdev", "git-akhi3"]. */
export async function ghAccounts(): Promise<string[]> {
  const r = await run('gh', ['auth', 'status', '--hostname', 'github.com']);
  const text = r.stdout + r.stderr;
  return [...text.matchAll(/Logged in to github\.com account (\S+)/g)].map((m) => m[1]!);
}
