// PR review helpers: pure functions plus the repo ↔ GitHub mapping.

import { parseDoc } from './handoffs.js';
import { run } from './util/exec.js';

export interface PrRef {
  owner: string;
  name: string;
  number: number;
}

export function parsePrUrl(url: string): PrRef {
  const m = url.trim().match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/);
  if (!m) throw new Error('Paste a GitHub pull request link, like https://github.com/owner/repo/pull/123');
  return { owner: m[1]!, name: m[2]!, number: Number(m[3]) };
}

export const prSlug = (r: { owner: string; name: string }) => `${r.owner}/${r.name}`.toLowerCase();

/** owner/name of a checkout's origin remote, or null if it isn't on GitHub. */
export async function originSlug(repoPath: string): Promise<string | null> {
  const r = await run('git', ['remote', 'get-url', 'origin'], { cwd: repoPath });
  const m = r.stdout.trim().match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  return m ? prSlug({ owner: m[1]!, name: m[2]! }) : null;
}

/**
 * Lines GitHub accepts review comments on: new-side lines inside the diff's hunks
 * (added or context). Keyed by file path.
 */
export function commentableLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let file: string | null = null;
  let line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git')) {
      file = null;
      continue;
    }
    const plus = raw.match(/^\+\+\+ (?:b\/)?(.+)$/);
    if (plus) {
      file = plus[1] === '/dev/null' ? null : plus[1]!;
      if (file && !out.has(file)) out.set(file, new Set());
      continue;
    }
    if (raw.startsWith('--- ')) continue;
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!file || line === 0) continue;
    if (raw.startsWith('+') || raw.startsWith(' ')) {
      out.get(file)!.add(line);
      line++;
    }
    // '-' lines exist only on the old side; '\' is "no newline at end of file".
  }
  return out;
}

export interface DraftComment {
  severity: 'blocking' | 'suggestion' | 'nit';
  path: string;
  line: number;
  body: string;
}

/** Parses the reviewer's pr-review.md: a summary and "- [severity] path:line — text" comments. */
export function parseReviewDoc(text: string): { summary: string; comments: DraftComment[] } {
  const { body } = parseDoc(text);
  const summary = body.match(/## Summary\s*\n([\s\S]*?)(?=\n## |\s*$)/)?.[1]?.trim() ?? '';
  const comments: DraftComment[] = [];
  for (const m of body.matchAll(/^- \[(blocking|suggestion|nit)\]\s+`?([^\s`:]+)`?:(\d+)\s*[—–-]+\s*(.+)$/gm)) {
    comments.push({ severity: m[1] as DraftComment['severity'], path: m[2]!, line: Number(m[3]), body: m[4]!.trim() });
  }
  return { summary, comments };
}

/** Comments GitHub would reject (outside the diff) go into the review body instead of being dropped. */
export function splitComments<T extends { path: string; line: number }>(comments: T[], commentable: Map<string, Set<number>>): { inline: T[]; general: T[] } {
  const inline: T[] = [];
  const general: T[] = [];
  for (const c of comments) (commentable.get(c.path)?.has(c.line) ? inline : general).push(c);
  return { inline, general };
}

export const formatComment = (c: { severity: string; body: string }) =>
  c.severity === 'blocking' ? `**Blocking:** ${c.body}` : c.severity === 'nit' ? `**Nit:** ${c.body}` : c.body;

export function reviewBody(summary: string, general: Array<{ severity: string; path: string; line: number; body: string }>): string {
  const extra = general.map((c) => `- \`${c.path}:${c.line}\` ${formatComment(c)}`).join('\n');
  return [summary.trim(), extra && `**Also:**\n${extra}`].filter(Boolean).join('\n\n');
}
