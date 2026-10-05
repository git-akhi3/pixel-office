// Everything that leaves the machine. Only the office calls these, after the push gate.

import type { Repo } from './db/schema.js';
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
  pushAndOpenDraftPr(repo: Repo, worktree: string, branch: string, pr: { title: string; body: string; base: string }): Promise<string>;
  prState(repo: Repo, prUrl: string): Promise<'OPEN' | 'MERGED' | 'CLOSED' | 'UNKNOWN'>;
  prInfo(repo: Repo, slug: string, number: number): Promise<PrInfo>;
  /** Always posted as a COMMENT review: approving or requesting changes stays a human click on GitHub. */
  postReview(repo: Repo, slug: string, number: number, review: PostedReview): Promise<string>;
  reviewRequests(account: string | null): Promise<ReviewRequest[]>;
  login(account: string | null): Promise<string>;
  /** A review I already posted on this commit (to avoid posting twice after a restart), or null. */
  findMyReview(repo: Repo, slug: string, number: number, commitId: string): Promise<string | null>;
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
  async pushAndOpenDraftPr(repo: Repo, worktree: string, branch: string, pr: { title: string; body: string; base: string }): Promise<string> {
    assertPushAllowed(repo, branch);
    const env = await ghEnv(repo.ghAccount);
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
      ['pr', 'create', '--draft', '--base', pr.base, '--head', branch, '--title', pr.title, '--body-file', '-'],
      { cwd: worktree, env, input: pr.body, timeoutMs: 120_000 },
    );
    const url = out.trim().split('\n').pop() ?? '';
    if (!/^https:\/\//.test(url)) throw new Error(`gh pr create returned no URL: ${out.slice(0, 300)}`);
    return url;
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

  async findMyReview(repo: Repo, slug: string, number: number, commitId: string): Promise<string | null> {
    const me = (await this.login(repo.ghAccount)).toLowerCase();
    const out = await runOk('gh', ['api', '--paginate', `repos/${slug}/pulls/${number}/reviews`], { env: await ghEnv(repo.ghAccount) });
    const reviews = JSON.parse(out.replace(/\]\s*\[/g, ',')) as Array<{ user: { login: string } | null; commit_id: string; html_url: string }>;
    return reviews.find((r) => r.user?.login.toLowerCase() === me && r.commit_id === commitId)?.html_url ?? null;
  }

  async login(account: string | null): Promise<string> {
    return (await runOk('gh', ['api', 'user', '--jq', '.login'], { env: await ghEnv(account) })).trim();
  }
}
