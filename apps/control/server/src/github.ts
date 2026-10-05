// Everything that leaves the machine. Only the office calls these, after the push gate.

import type { Repo } from './db/schema.js';
import { git, run, runOk } from './util/exec.js';

export interface Publisher {
  pushAndOpenDraftPr(repo: Repo, worktree: string, branch: string, pr: { title: string; body: string }): Promise<string>;
  prState(repo: Repo, prUrl: string): Promise<'OPEN' | 'MERGED' | 'CLOSED' | 'UNKNOWN'>;
}

/** Hard limits, enforced here regardless of settings. */
export function assertPushAllowed(repo: Repo, branch: string): void {
  if (!branch.startsWith('office/')) throw new Error(`Refusing to push ${branch}: only office/* branches are pushed.`);
  const protectedBranches = new Set(['main', 'master', repo.defaultBranch, ...repo.protectedBranches]);
  if (protectedBranches.has(branch)) throw new Error(`Refusing to push protected branch ${branch}.`);
}

async function ghEnv(repo: Repo): Promise<NodeJS.ProcessEnv> {
  if (!repo.ghAccount) return process.env;
  const token = (await runOk('gh', ['auth', 'token', '--hostname', 'github.com', '--user', repo.ghAccount])).trim();
  return { ...process.env, GH_TOKEN: token };
}

export class GhPublisher implements Publisher {
  async pushAndOpenDraftPr(repo: Repo, worktree: string, branch: string, pr: { title: string; body: string }): Promise<string> {
    assertPushAllowed(repo, branch);
    const env = await ghEnv(repo);
    // Use gh as the credential helper so HTTPS pushes go out as the repo's gh account.
    await git(
      worktree,
      ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', '--set-upstream', 'origin', `${branch}:${branch}`],
      { env, timeoutMs: 180_000 },
    );
    const existing = await run('gh', ['pr', 'view', branch, '--json', 'url', '--jq', '.url'], { cwd: worktree, env });
    if (existing.code === 0 && existing.stdout.trim()) return existing.stdout.trim();
    const out = await runOk(
      'gh',
      ['pr', 'create', '--draft', '--base', repo.defaultBranch, '--head', branch, '--title', pr.title, '--body-file', '-'],
      { cwd: worktree, env, input: pr.body, timeoutMs: 120_000 },
    );
    const url = out.trim().split('\n').pop() ?? '';
    if (!/^https:\/\//.test(url)) throw new Error(`gh pr create returned no URL: ${out.slice(0, 300)}`);
    return url;
  }

  async prState(repo: Repo, prUrl: string): Promise<'OPEN' | 'MERGED' | 'CLOSED' | 'UNKNOWN'> {
    const r = await run('gh', ['pr', 'view', prUrl, '--json', 'state', '--jq', '.state'], { env: await ghEnv(repo) });
    const s = r.stdout.trim();
    return s === 'OPEN' || s === 'MERGED' || s === 'CLOSED' ? s : 'UNKNOWN';
  }
}
