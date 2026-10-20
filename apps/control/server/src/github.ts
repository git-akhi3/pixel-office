// Everything that leaves the machine. Only the office calls these: pushes once the checks pass, merges after my approval.

import type { Repo } from './db/schema.js';
import type { MergeMethod } from './domain.js';
import { git, run, runOk } from './util/exec.js';

export interface PrInfo {
  title: string;
  body: string;
  author: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  changedLines: number;
  state: string;
  /** owner/name the head branch lives in; differs from the base repo for fork PRs. */
  headRepo: string | null;
}

export interface ReviewRequest {
  url: string;
  repo: string; // owner/name
  number: number;
  title: string;
  changedLines: number;
}

export interface PostedReview {
  body: string;
  commitId: string;
  comments: Array<{ path: string; line: number; body: string }>;
}

export interface Publisher {
  /** Pushes the branch and opens its PR (ready for review, or a draft). A PR the branch already has keeps its URL and gets the new title and description. */
  pushAndOpenPr(repo: Repo, worktree: string, branch: string, pr: { title: string; body: string; base: string; draft: boolean }): Promise<string>;
  /**
   * Merges an open PR, after my approval. With headSha, only while the PR's head is still that commit
   * (anything pushed since makes GitHub refuse). Branch protection and required checks still apply.
   */
  mergePr(repo: Repo, prUrl: string, method: MergeMethod, headSha?: string | null): Promise<void>;
  /** Points an open PR at another base branch (a milestone whose predecessor has merged). */
  retargetPr(repo: Repo, prUrl: string, base: string): Promise<void>;
  prState(repo: Repo, prUrl: string): Promise<'OPEN' | 'MERGED' | 'CLOSED' | 'UNKNOWN'>;
  prInfo(repo: Repo, slug: string, number: number): Promise<PrInfo>;
  /** Always posted as a COMMENT review: approving or requesting changes stays a human click on GitHub. */
  postReview(repo: Repo, slug: string, number: number, review: PostedReview): Promise<string>;
  reviewRequests(account: string | null): Promise<ReviewRequest[]>;
  login(account: string | null): Promise<string>;
  /** A submitted review whose body contains `marker` (to avoid posting twice after a crash mid-post), or null. */
  findReviewWithMarker(repo: Repo, slug: string, number: number, marker: string): Promise<string | null>;
}

/** Hard limits, enforced here regardless of settings. */
export function assertPushAllowed(repo: Repo, branch: string): void {
  if (!branch.startsWith('office/')) throw new Error(`Refusing to push ${branch}: only office/* branches are pushed.`);
  const protectedBranches = new Set(['main', 'master', repo.defaultBranch, ...repo.protectedBranches]);
  if (protectedBranches.has(branch)) throw new Error(`Refusing to push protected branch ${branch}.`);
}

async function ghEnv(account: string | null): Promise<NodeJS.ProcessEnv> {
  if (!account) return process.env;
  const token = (await runOk('gh', ['auth', 'token', '--hostname', 'github.com', '--user', account])).trim();
  return { ...process.env, GH_TOKEN: token };
}

export class GhPublisher implements Publisher {
  async pushAndOpenPr(repo: Repo, worktree: string, branch: string, pr: { title: string; body: string; base: string; draft: boolean }): Promise<string> {
    assertPushAllowed(repo, branch);
    const env = await ghEnv(repo.ghAccount);
    // Use gh as the credential helper so HTTPS pushes go out as the repo's gh account.
    await git(
      worktree,
      ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', '--set-upstream', 'origin', `${branch}:${branch}`],
      { env, timeoutMs: 180_000 },
    );
    const existing = await run('gh', ['pr', 'view', branch, '--json', 'url', '--jq', '.url'], { cwd: worktree, env });
    if (existing.code === 0 && existing.stdout.trim()) {
      const url = existing.stdout.trim();
      await runOk('gh', ['pr', 'edit', url, '--title', pr.title, '--body-file', '-'], { cwd: worktree, env, input: pr.body, timeoutMs: 60_000 });
      return url;
    }
    const out = await runOk(
      'gh',
      ['pr', 'create', ...(pr.draft ? ['--draft'] : []), '--base', pr.base, '--head', branch, '--title', pr.title, '--body-file', '-'],
      { cwd: worktree, env, input: pr.body, timeoutMs: 120_000 },
    );
    const url = out.trim().split('\n').pop() ?? '';
    if (!/^https:\/\//.test(url)) throw new Error(`gh pr create returned no URL: ${out.slice(0, 300)}`);
    return url;
  }

  async mergePr(repo: Repo, prUrl: string, method: MergeMethod, headSha?: string | null): Promise<void> {
    const pin = headSha ? ['--match-head-commit', headSha] : [];
    await runOk('gh', ['pr', 'merge', prUrl, `--${method}`, ...pin], { env: await ghEnv(repo.ghAccount), timeoutMs: 120_000 });
  }

  async retargetPr(repo: Repo, prUrl: string, base: string): Promise<void> {
    await runOk('gh', ['pr', 'edit', prUrl, '--base', base], { env: await ghEnv(repo.ghAccount), timeoutMs: 60_000 });
  }

  async prState(repo: Repo, prUrl: string): Promise<'OPEN' | 'MERGED' | 'CLOSED' | 'UNKNOWN'> {
    const r = await run('gh', ['pr', 'view', prUrl, '--json', 'state', '--jq', '.state'], { env: await ghEnv(repo.ghAccount) });
    const s = r.stdout.trim();
    return s === 'OPEN' || s === 'MERGED' || s === 'CLOSED' ? s : 'UNKNOWN';
  }

  async prInfo(repo: Repo, slug: string, number: number): Promise<PrInfo> {
    const out = await runOk('gh', ['api', `repos/${slug}/pulls/${number}`], { env: await ghEnv(repo.ghAccount) });
    const pr = JSON.parse(out) as {
      title: string;
      body: string | null;
      user: { login: string };
      head: { sha: string; ref: string; repo: { full_name: string } | null };
      base: { ref: string };
      additions: number;
      deletions: number;
      state: string;
    };
    return {
      title: pr.title,
      body: pr.body ?? '',
      author: pr.user.login,
      headSha: pr.head.sha,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
      changedLines: pr.additions + pr.deletions,
      state: pr.state,
      headRepo: pr.head.repo?.full_name.toLowerCase() ?? null,
    };
  }

  async postReview(repo: Repo, slug: string, number: number, review: PostedReview): Promise<string> {
    const payload = {
      commit_id: review.commitId,
      body: review.body,
      event: 'COMMENT',
      comments: review.comments.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.body })),
    };
    const out = await runOk('gh', ['api', '-X', 'POST', `repos/${slug}/pulls/${number}/reviews`, '--input', '-'], {
      env: await ghEnv(repo.ghAccount),
      input: JSON.stringify(payload),
    });
    return (JSON.parse(out) as { html_url: string }).html_url;
  }

  async reviewRequests(account: string | null): Promise<ReviewRequest[]> {
    const out = await runOk(
      'gh',
      ['search', 'prs', '--review-requested=@me', '--state=open', '--limit', '50', '--json', 'url,repository,number,title'],
      { env: await ghEnv(account) },
    );
    const items = JSON.parse(out) as Array<{ url: string; repository: { nameWithOwner: string }; number: number; title: string }>;
    return items.map((i) => ({ url: i.url, repo: i.repository.nameWithOwner.toLowerCase(), number: i.number, title: i.title, changedLines: -1 }));
  }

  async findReviewWithMarker(repo: Repo, slug: string, number: number, marker: string): Promise<string | null> {
    const out = await runOk('gh', ['api', '--paginate', `repos/${slug}/pulls/${number}/reviews`], { env: await ghEnv(repo.ghAccount) });
    const reviews = JSON.parse(out.replace(/\]\s*\[/g, ',')) as Array<{ body: string | null; state: string; html_url: string }>;
    return reviews.find((r) => r.state !== 'PENDING' && (r.body ?? '').includes(marker))?.html_url ?? null;
  }

  async login(account: string | null): Promise<string> {
    return (await runOk('gh', ['api', 'user', '--jq', '.login'], { env: await ghEnv(account) })).trim();
  }
}
