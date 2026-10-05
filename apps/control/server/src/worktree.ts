import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { Repo } from './db/schema.js';
import { git, run } from './util/exec.js';

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .split('-')
      .slice(0, 6)
      .join('-')
      .slice(0, 40) || 'task'
  );
}

export function branchName(taskId: number, title: string): string {
  return `office/${taskId}-${slugify(title)}`;
}

/** Creates the task's worktree on a new office branch from the latest default branch. */
export async function createWorktree(
  repo: Repo,
  worktreesDir: string,
  taskId: number,
  title: string,
): Promise<{ path: string; branch: string; baseSha: string }> {
  const path = join(worktreesDir, String(taskId));
  const branch = branchName(taskId, title);
  if (existsSync(path)) {
    const baseSha = (await git(path, ['rev-parse', 'HEAD'])).trim();
    return { path: realpathSync(path), branch, baseSha };
  }
  // Best effort: work offline if the fetch fails.
  await run('git', ['fetch', '--quiet', 'origin', repo.defaultBranch], { cwd: repo.path, timeoutMs: 60_000 });
  const remoteRef = `origin/${repo.defaultBranch}`;
  const hasRemote = (await run('git', ['rev-parse', '--verify', '--quiet', remoteRef], { cwd: repo.path })).code === 0;
  await git(repo.path, ['worktree', 'add', '-b', branch, path, hasRemote ? remoteRef : repo.defaultBranch]);
  const baseSha = (await git(path, ['rev-parse', 'HEAD'])).trim();
  if (repo.setupCmd) {
    // Configured by me, run by the office: not subject to the agent guard.
    const setup = await run('/bin/sh', ['-c', repo.setupCmd], { cwd: path, env: { ...process.env, REPO_PATH: repo.path }, timeoutMs: 15 * 60_000 });
    if (setup.code !== 0) throw new Error(`Setup command failed (${setup.code}): ${(setup.stderr || setup.stdout).trim().slice(-500)}`);
  }
  return { path: realpathSync(path), branch, baseSha };
}

function parseAuthor(author: string | null): { name: string; email: string } | null {
  const m = author?.match(/^(.+?)\s*<([^>]+)>$/);
  return m ? { name: m[1]!, email: m[2]! } : null;
}

/** Commits everything in the worktree. Returns false when there was nothing to commit. */
export async function commitAll(worktree: string, message: string, fallbackAuthor: string | null): Promise<boolean> {
  await git(worktree, ['add', '-A']);
  const staged = await run('git', ['diff', '--cached', '--quiet'], { cwd: worktree });
  if (staged.code === 0) return false;
  const identity: string[] = [];
  const configured = (await run('git', ['config', 'user.email'], { cwd: worktree })).stdout.trim();
  if (!configured) {
    const a = parseAuthor(fallbackAuthor);
    if (!a) throw new Error('No git identity for this repo. Set "Git author" on the repo in the office, or git config user.email in the repo.');
    identity.push('-c', `user.name=${a.name}`, '-c', `user.email=${a.email}`);
  }
  // --no-verify: the coder already ran lint/tests; repo hooks must not break the pipeline halfway.
  await git(worktree, [...identity, 'commit', '--no-verify', '--quiet', '-m', message]);
  return true;
}

/** Files changed since the base commit, including uncommitted ones. */
export async function changedFiles(worktree: string, baseSha: string): Promise<string[]> {
  const committed = await git(worktree, ['diff', '--name-only', baseSha]);
  const untracked = await git(worktree, ['ls-files', '--others', '--exclude-standard']);
  return [...new Set([...committed.split('\n'), ...untracked.split('\n')].map((s) => s.trim()).filter(Boolean))];
}

export async function diff(worktree: string, baseSha: string, maxChars = 400_000): Promise<string> {
  const out = await git(worktree, ['diff', '--stat', '--patch', baseSha]);
  return out.length > maxChars ? `${out.slice(0, maxChars)}\n\n… diff truncated (${out.length} chars)` : out;
}

export async function removeWorktree(repo: Repo, path: string): Promise<void> {
  if (!existsSync(path)) return;
  await git(repo.path, ['worktree', 'remove', '--force', path]);
}
