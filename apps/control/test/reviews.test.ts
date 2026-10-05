import { describe, expect, it } from 'vitest';
import { commentableLines, formatComment, parsePrUrl, parseReviewDoc, reviewBody, splitComments } from '../server/src/reviews.js';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 line one
-old two
+new two
+added three
 line four
@@ -20,2 +21,2 @@ function x() {
 ctx
+tail
diff --git a/src/gone.ts b/src/gone.ts
--- a/src/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/src/new.ts b/src/new.ts
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+a
+b`;

describe('parsePrUrl', () => {
  it('parses PR links, with or without a trailing path', () => {
    expect(parsePrUrl('https://github.com/acme/app/pull/42')).toEqual({ owner: 'acme', name: 'app', number: 42 });
    expect(parsePrUrl('https://github.com/acme/my.app/pull/7/files#diff')).toEqual({ owner: 'acme', name: 'my.app', number: 7 });
  });
  it('rejects anything else', () => {
    expect(() => parsePrUrl('https://github.com/acme/app/issues/42')).toThrow(/pull request link/);
    expect(() => parsePrUrl('https://evil.example/acme/app/pull/1')).toThrow();
  });
});

describe('commentableLines', () => {
  const lines = commentableLines(DIFF);
  it('includes added and context lines on the new side', () => {
    expect([...lines.get('src/a.ts')!].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 21, 22]);
    expect([...lines.get('src/new.ts')!]).toEqual([1, 2]);
  });
  it('ignores deleted files', () => {
    expect(lines.has('src/gone.ts')).toBe(false);
  });
});

describe('parseReviewDoc', () => {
  it('reads the summary and comments, including backticked paths and different dashes', () => {
    const doc = `---\nverdict: request_changes\n---\n## Summary\nAdds caching. One bug.\n\n## Comments\n- [blocking] src/a.ts:3 — off by one\n- [nit] \`src/new.ts\`:2 - naming\n- [suggestion] src/a.ts:21 – extract helper`;
    const { summary, comments } = parseReviewDoc(doc);
    expect(summary).toBe('Adds caching. One bug.');
    expect(comments).toEqual([
      { severity: 'blocking', path: 'src/a.ts', line: 3, body: 'off by one' },
      { severity: 'nit', path: 'src/new.ts', line: 2, body: 'naming' },
      { severity: 'suggestion', path: 'src/a.ts', line: 21, body: 'extract helper' },
    ]);
  });
});

describe('splitComments and reviewBody', () => {
  it('moves comments GitHub would reject into the review body', () => {
    const comments = [
      { severity: 'blocking', path: 'src/a.ts', line: 3, body: 'bug' },
      { severity: 'nit', path: 'src/a.ts', line: 10, body: 'outside the diff' },
      { severity: 'suggestion', path: 'other.ts', line: 1, body: 'not in the PR' },
    ];
    const { inline, general } = splitComments(comments, commentableLines(DIFF));
    expect(inline.map((c) => c.line)).toEqual([3]);
    expect(general).toHaveLength(2);
    const body = reviewBody('Looks good overall.', general);
    expect(body).toContain('Looks good overall.');
    expect(body).toContain('`src/a.ts:10` **Nit:** outside the diff');
    expect(formatComment(comments[0]!)).toBe('**Blocking:** bug');
  });
});
