import { describe, expect, it } from 'vitest';
import type { Task } from '../server/src/db/schema.js';
import { alertText, breakdownSummary, planSummary, progressBar, pushSummary, reviewPostSummary, statusBlocks, verificationText } from '../server/src/slackFormat.js';

const PLAN = `---
files_in_scope:
  - src/greet.ts
  - src/greet.test.ts
  - src/index.ts
  - README.md
token_estimate: 150000
---
## Goal
Add a **greet()** helper & export it.

## Acceptance criteria
- greet("a") returns "Hello, a"
- greet("") throws
- index re-exports greet
- README documents it
- lint passes

## Steps
1. src/greet.ts: write it
2. src/index.ts: export it

## Out of scope
- everything else

## Risks
- Empty names: chose to throw
- Unicode names are untested
- A third risk we will not show
`;

describe('planSummary', () => {
  const out = planSummary(PLAN);

  it('leads with the goal, then what done means, what it touches and what to watch', () => {
    expect(out.indexOf('*Goal*')).toBeLessThan(out.indexOf('*Done when*'));
    expect(out.indexOf('*Done when*')).toBeLessThan(out.indexOf('*Touches*'));
    expect(out.indexOf('*Touches*')).toBeLessThan(out.indexOf('*Watch out*'));
  });

  it('turns markdown into Slack formatting and escapes it', () => {
    expect(out).toContain('Add a *greet()* helper &amp; export it.');
    expect(out).not.toContain('**');
  });

  it('keeps the long lists short', () => {
    expect(out).toContain('*Done when* (5 checks)');
    expect(out).toContain('_+2 more on the board_');
    expect(out).toContain('4 files: `greet.ts`, `greet.test.ts`, `index.ts` +1');
    expect(out).toContain('~150k tokens');
    expect(out).toContain('Unicode names are untested');
    expect(out).not.toContain('third risk');
    expect(out).not.toContain('## ');
    expect(out.length).toBeLessThan(900);
  });

  it('does not throw on an empty or odd document', () => {
    expect(planSummary('')).toBe('');
    expect(planSummary('just some text')).toBe('');
  });
});

describe('breakdownSummary', () => {
  it('lists the milestone titles in order', () => {
    const doc = `---
milestones: 2
---
## Overview
A chat app.

## Milestones
### 1. Skeleton
Set up the repo.
- it builds

### 2. Messages
Send and receive.
- it sends
`;
    const out = breakdownSummary(doc);
    expect(out).toContain('A chat app.');
    expect(out).toContain('*2 milestones*\n1. Skeleton\n2. Messages');
    expect(out).not.toContain('Set up the repo');
  });
});

describe('pushSummary', () => {
  const changes = `---
status: done
---
## Changes
- Step 1: greet.ts

## PR
**Title:** Add greet helper
**Summary:**
- adds greet()
- exports it
**How it was tested:** vitest, 12 passed
`;
  it('shows the PR title, its summary and how review and tests went', () => {
    const out = pushSummary({ changes, review: '---\nverdict: pass\nblocking: 0\n---\n## Summary\nok', testReport: '---\nresult: pass\ntests_added: 3\n---\n## Suite\nok' });
    expect(out).toContain('*Add greet helper*\n• adds greet()\n• exports it');
    expect(out).toContain(':white_check_mark: Review passed');
    expect(out).toContain(':white_check_mark: Tests passed (+3 new)');
    expect(out).not.toContain('vitest');
  });

  it('says so when review or tests failed, and is empty with nothing to show', () => {
    expect(pushSummary({ review: '---\nverdict: fail\nblocking: 2\n---\n', testReport: '---\nresult: fail\ntests_added: 0\n---\n' })).toBe(':warning: Review: 2 blocking  ·  :x: Tests failing');
    expect(pushSummary({})).toBe('');
  });
});

describe('reviewPostSummary', () => {
  it('gives the verdict, the counts and only the blocking comments', () => {
    const out = reviewPostSummary(`---
verdict: request_changes
---
## Summary
Adds a cache. One real problem.

## Comments
- [blocking] src/cache.ts:42 — never expires
- [suggestion] src/cache.ts:57 — rename
- [nit] src/cache.ts:60 — spacing
`);
    expect(out).toContain('*:warning: Recommends changes · 1 blocking, 1 suggestion, 1 nit*');
    expect(out).toContain('Adds a cache. One real problem.');
    expect(out).toContain('• src/cache.ts:42 — never expires');
    expect(out).not.toContain('rename');
  });
});

describe('verificationText', () => {
  it('titles the report by verdict and escapes Slack markup', () => {
    expect(verificationText('fail', 'POST /webhook returned 500 <@U1>')).toBe(':x: Live check failed\nPOST /webhook returned 500 &lt;@U1&gt;');
    expect(verificationText('pass', 'ok').startsWith(':white_check_mark: Live check passed\n')).toBe(true);
  });
});

describe('alertText', () => {
  it('titles the alert and puts the detail under it', () => {
    expect(alertText('tokens', 'Used 300,000 tokens.')).toBe(':moneybag: Over budget\nUsed 300,000 tokens.');
    expect(alertText('something_new', 'x')).toBe(':rotating_light: Heads up\nx');
  });

  it("skips command permissions: the command's own gate message covers them", () => {
    expect(alertText('permission', 'Allow command? rm -rf /')).toBeNull();
  });
});

describe('statusBlocks', () => {
  const task = { id: 3, title: 'Add greet', status: 'coding', statusNote: null, prUrl: null } as unknown as Task;

  it('shows what is happening, the progress and the small print on separate lines', () => {
    const { text, blocks } = statusBlocks({ task, agent: 'coder', elapsed: '2m 10s', stage: { n: 5, of: 12 }, tokens: 12_345 });
    const lines = (blocks[0] as { text: { text: string } }).text.text.split('\n');
    expect(lines).toEqual(['*#3* Add greet', '*:hammer_and_wrench: Building* · coder working for 2m 10s', '▰▰▰▰▰▱▱▱▱▱▱▱  stage 5 of 12']);
    expect(JSON.stringify(blocks[1])).toContain('12.3k tokens');
    expect(text).toBe('#3 Add greet: Building');
  });

  it('draws progress without going past the end', () => {
    expect(progressBar(3, 5)).toBe('▰▰▰▱▱');
    expect(progressBar(9, 5)).toBe('▰▰▰▰▰');
  });
});
