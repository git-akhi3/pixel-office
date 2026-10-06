import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
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

/** Creates the task's worktree on a new office branch from the latest base branch (the default branch unless given). */
export async function createWorktree(
  repo: Repo,
  worktreesDir: string,
  taskId: number,
  title: string,
  baseBranch: string = repo.defaultBranch,
): Promise<{ path: string; branch: string; baseSha: string }> {
  const path = join(worktreesDir, String(taskId));
  const branch = branchName(taskId, title);
  if (existsSync(path)) {
    const baseSha = (await git(path, ['rev-parse', 'HEAD'])).trim();
    return { path: realpathSync(path), branch, baseSha };
  }
  // Best effort: work offline if the fetch fails.
  await run('git', ['fetch', '--quiet', 'origin', baseBranch], { cwd: repo.path, timeoutMs: 60_000 });
  const remoteRef = `origin/${baseBranch}`;
  const hasRemote = (await run('git', ['rev-parse', '--verify', '--quiet', remoteRef], { cwd: repo.path })).code === 0;
  await git(repo.path, ['worktree', 'add', '-b', branch, path, hasRemote ? remoteRef : baseBranch]);
  const baseSha = (await git(path, ['rev-parse', 'HEAD'])).trim();
  await runSetup(repo, path);
  return { path: realpathSync(path), branch, baseSha };
}

/**
 * A detached checkout of a pull request's head for reviewing. baseSha is the merge base with the PR's
 * base branch, so the diff shows exactly the PR's changes.
 *
 * The PR head is fetched into a ref unique to this task (concurrent reviews must not share FETCH_HEAD).
 * The setup command is NOT run: a PR's code is untrusted and must never execute here.
 */
export async function createReviewWorktree(
  repo: Repo,
  worktreesDir: string,
  taskId: number,
  prNumber: number,
  baseRef: string,
): Promise<{ path: string; headSha: string; baseSha: string }> {
  const path = join(worktreesDir, String(taskId));
  if (!existsSync(path)) {
    const ref = reviewRef(taskId);
    // Two reviews on the same base may update origin/<base> at once: retry on a ref-lock failure.
    for (let attempt = 1; ; attempt++) {
      try {
        await git(repo.path, ['fetch', '--quiet', 'origin', `+pull/${prNumber}/head:${ref}`, `+${baseRef}:refs/remotes/origin/${baseRef}`], { timeoutMs: 120_000 });
        break;
      } catch (e) {
        if (attempt >= 3 || !/lock|cannot lock ref/i.test(String(e))) throw e;
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
    await git(repo.path, ['worktree', 'add', '--detach', path, ref]);
  }
  const headSha = (await git(path, ['rev-parse', 'HEAD'])).trim();
  const baseSha = (await git(path, ['merge-base', `origin/${baseRef}`, 'HEAD'])).trim();
  return { path: realpathSync(path), headSha, baseSha };
}

export const reviewRef = (taskId: number) => `refs/office/pr/${taskId}`;

async function runSetup(repo: Repo, path: string): Promise<void> {
  if (repo.setupCmd) {
    // Configured by me, run by the office: not subject to the agent guard.
    const setup = await run('/bin/sh', ['-c', repo.setupCmd], { cwd: path, env: { ...process.env, REPO_PATH: repo.path }, timeoutMs: 15 * 60_000 });
    if (setup.code !== 0) throw new Error(`Setup command failed (${setup.code}): ${(setup.stderr || setup.stdout).trim().slice(-500)}`);
    // Symlinked venvs/node_modules are not matched by "dir/" ignore patterns: remember them so they are never committed.
    const created = (await git(path, ['ls-files', '--others', '--exclude-standard', '--directory'])).split('\n').map((l) => l.trim().replace(/\/$/, '')).filter(Boolean);
    if (created.length) writeFileSync(await artifactsFile(path), created.join('\n') + '\n');
  }
}

/** Per-worktree list of paths made by the setup command, kept in the worktree's private git dir. */
async function artifactsFile(worktree: string): Promise<string> {
  const gitDir = (await git(worktree, ['rev-parse', '--absolute-git-dir'])).trim();
  return join(gitDir, 'office-setup-artifacts');
}

export async function setupArtifacts(worktree: string): Promise<string[]> {
  const f = await artifactsFile(worktree);
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
}

function parseAuthor(author: string | null): { name: string; email: string } | null {
  const m = author?.match(/^(.+?)\s*<([^>]+)>$/);
  return m ? { name: m[1]!, email: m[2]! } : null;
}

/** Commits everything in the worktree. Returns false when there was nothing to commit. */
export async function commitAll(worktree: string, message: string, fallbackAuthor: string | null): Promise<boolean> {
  const excluded = (await setupArtifacts(worktree)).map((p) => `:(exclude)${p}`);
  await git(worktree, ['add', '-A', '--', '.', ...excluded]);
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
  const artifacts = await setupArtifacts(worktree);
  return [...new Set([...committed.split('\n'), ...untracked.split('\n')].map((s) => s.trim()).filter(Boolean))].filter(
    (f) => !artifacts.some((a) => f === a || f.startsWith(`${a}/`)),
  );
}

/** Lines added plus removed per file since the base commit (committed work; binary files count as 0). */
export async function diffStat(worktree: string, baseSha: string): Promise<Array<{ file: string; lines: number }>> {
  const out = await git(worktree, ['diff', '--numstat', '--no-renames', baseSha]);
  return out
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((p) => p.length >= 3 && p[2])
    .map(([added, removed, file]) => ({ file: file!, lines: (Number(added) || 0) + (Number(removed) || 0) }));
}

/** Stable diff output whatever the user's git config says (prefixes, color, external diff tools). */
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/'];

/** The diff from base. `committedOnly` compares base..HEAD, ignoring anything uncommitted in the worktree. */
export async function diff(worktree: string, baseSha: string, maxChars = 400_000, committedOnly = false): Promise<string> {
  const out = await git(worktree, ['diff', ...DIFF_FLAGS, '--stat', '--patch', baseSha, ...(committedOnly ? ['HEAD'] : [])]);
  return out.length > maxChars ? `${out.slice(0, maxChars)}\n\n… diff truncated (${out.length} chars)` : out;
}

export async function removeWorktree(repo: Repo, path: string, taskId?: number): Promise<void> {
  if (existsSync(path)) await git(repo.path, ['worktree', 'remove', '--force', path]);
  if (taskId !== undefined) await run('git', ['update-ref', '-d', reviewRef(taskId)], { cwd: repo.path });
}
