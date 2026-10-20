import { describe, expect, it } from 'vitest';
import type { Task } from '../server/src/db/schema.js';
import { alertText, breakdownSummary, handoffText, planSummary, progressBar, pushSummary, reviewPostSummary, statusBlocks, verificationText } from '../server/src/slackFormat.js';

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

  it('names the stage and the commit it checked', () => {
    expect(verificationText('partial', 'Not deployed yet.', 'deployed', '36d945d1c0ffee')).toBe(':warning: Production check partly done (`36d945d`)\nNot deployed yet.');
    expect(verificationText('fail', 'x', 'pr', 'abcdef1').startsWith(':x: PR re-check failed (`abcdef1`)\n')).toBe(true);
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

describe('handoffText', () => {
  const doc = (meta: string, body: string) => `---\n${meta}\n---\n${body}`;

  it("gives the plan's goal and size, and the review and test verdicts", () => {
    expect(handoffText('planning', doc('files_in_scope: [a.ts, b.ts, c.ts]', '## Goal\nAdd **greet()**.\n\n## Acceptance criteria\n- one\n- two'), null)).toBe('Plan is ready: Add *greet()*.\n2 checks, touches 3 files');
    expect(handoffText('reviewing', doc('verdict: pass\nblocking: 0', '## Summary\nLooks right.'), null)).toBe(':white_check_mark: Review passed. Looks right.');
    expect(handoffText('reviewing', doc('verdict: fail\nblocking: 1', '## Summary\nOne bug.'), null)).toBe(':warning: Review found 1 blocking issue. One bug.');
    expect(handoffText('testing', doc('result: pass\ntests_added: 2', '## Suite\nnpm test: 40 passed'), null)).toBe(':white_check_mark: Tests pass (+2 new). npm test: 40 passed');
    expect(handoffText('testing', doc('result: fail\ntests_added: 0', '## Suite\n2 failed'), null)).toBe(':x: Tests fail. 2 failed');
  });

  it('counts the files the build touched, and says how it was tested', () => {
    const changes = doc('status: done', '## Changes\n- Step 1: a.ts\n- Step 2: b.ts\n\n## PR\n**Title:** Add greet\n**Summary:**\n- adds it\n**How it was tested:** npm test: 40 passed');
    expect(handoffText('coding', changes, 5)).toBe('Done: 5 files changed, tests: npm test: 40 passed');
    // Without git's count, the changes list is counted.
    expect(handoffText('coding', changes, null)).toBe('Done: 2 files changed, tests: npm test: 40 passed');
    expect(handoffText('coding', doc('status: blocked', '## Question\nWhich one?'), null)).toBeNull();
  });

  it('is silent for steps with nothing to add, and for a missing document', () => {
    expect(handoffText('intake', doc('title: x', '## Request\nx'), null)).toBeNull();
    expect(handoffText('retro', doc('', '- **Went well:** x'), null)).toBeNull();
    expect(handoffText('planning', null, null)).toBeNull();
  });

  it("reports the cause a debugger found, research answers, and an epic's split", () => {
    expect(handoffText('debugging', doc('reproduced: true', '## Root cause\nThe cache key ignores the locale (cache.ts:12).'), null)).toBe('Found the cause: The cache key ignores the locale (cache.ts:12).');
    expect(handoffText('researching', doc('', '## Answers\n- A: x\n- B: y'), null)).toBe('Research is in: 2 answers.');
    expect(handoffText('splitting', doc('milestones: 3', '## Milestones\n### 1. a\nx'), null)).toBe('Split into 3 milestones.');
  });
});
