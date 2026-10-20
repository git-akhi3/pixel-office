import { describe, expect, it } from 'vitest';
import { maxLane } from '../server/src/domain.js';
import { parseMilestones, validateDoc } from '../server/src/handoffs.js';
import { isDocFile, laneAtIntake, reviewReason, SMALL_MAX_FILES, SMALL_MAX_LINES } from '../server/src/lanes.js';

const facts = { size: 'S' as const, designFlag: false, grill: false };

describe('isDocFile', () => {
  it('knows prose files from code', () => {
    for (const f of ['README.md', 'docs/guide.mdx', 'notes.txt', 'LICENSE', 'CHANGELOG', 'pkg/README.rst']) expect(isDocFile(f)).toBe(true);
    for (const f of ['src/app.ts', 'package.json', 'config.yml', 'Makefile', 'readme.ts']) expect(isDocFile(f)).toBe(false);
  });

  it('counts markdown that steers agents as code', () => {
    for (const f of ['CLAUDE.md', 'app/AGENTS.md', 'skills/deploy/SKILL.md', 'apps/control/agents/coder.md', '.claude/commands/ship.md', '.github/copilot-instructions.md']) {
      expect(isDocFile(f)).toBe(false);
    }
  });
});

describe('laneAtIntake', () => {
  it("takes the manager's solo for S and M tasks", () => {
    expect(laneAtIntake({ ...facts, said: 'solo' })).toEqual({ lane: 'solo', reason: 'The manager routed it as solo.' });
    expect(laneAtIntake({ ...facts, said: 'solo', size: 'M' }).lane).toBe('solo');
  });

  it('reads the lanes from before solo as solo', () => {
    expect(laneAtIntake({ ...facts, said: 'trivial' }).lane).toBe('solo');
    expect(laneAtIntake({ ...facts, said: 'small' }).lane).toBe('solo');
  });

  it('is standard when the manager said so, or said nothing', () => {
    expect(laneAtIntake({ ...facts, said: 'standard' }).lane).toBe('standard');
    expect(laneAtIntake(facts)).toEqual({ lane: 'standard', reason: 'The manager gave no lane.' });
  });

  it('sends a task to the full team when it needs the architect', () => {
    expect(laneAtIntake({ ...facts, said: 'solo', size: 'L' })).toMatchObject({ lane: 'standard', reason: expect.stringContaining('size L') });
    expect(laneAtIntake({ ...facts, said: 'solo', grill: true }).reason).toContain('briefing');
    expect(laneAtIntake({ ...facts, said: 'solo', designFlag: true }).lane).toBe('standard');
  });

  it('follows my pick over the manager', () => {
    expect(laneAtIntake({ ...facts, said: 'solo', pick: 'standard' })).toEqual({ lane: 'standard', reason: 'You asked for the full team.' });
    expect(laneAtIntake({ ...facts, said: 'standard', pick: 'solo' })).toEqual({ lane: 'solo', reason: 'You picked solo.' });
    expect(laneAtIntake({ ...facts, said: 'standard', pick: 'solo', size: 'L' }).lane).toBe('solo');
  });

  it('still sends my solo pick to the full team for a briefing (the architect asks the questions)', () => {
    expect(laneAtIntake({ ...facts, pick: 'solo', grill: true })).toEqual({ lane: 'standard', reason: 'You picked solo, but it gets a briefing.' });
    expect(laneAtIntake({ ...facts, pick: 'solo', designFlag: true }).lane).toBe('solo');
  });
});

describe('reviewReason', () => {
  it('leaves a small change to the all-rounder alone', () => {
    expect(reviewReason([{ file: 'src/a.ts', lines: SMALL_MAX_LINES }])).toBeNull();
    expect(reviewReason([])).toBeNull();
  });

  it('asks for a review of a big change', () => {
    expect(reviewReason([{ file: 'src/a.ts', lines: SMALL_MAX_LINES + 1 }])).toBe(`it changed ${SMALL_MAX_LINES + 1} lines`);
    expect(reviewReason(Array.from({ length: SMALL_MAX_FILES + 1 }, (_, i) => ({ file: `src/${i}.ts`, lines: 1 })))).toBe(`it changed ${SMALL_MAX_FILES + 1} files`);
  });

  it("doesn't count prose files", () => {
    expect(reviewReason([{ file: 'docs/guide.md', lines: 900 }, { file: 'src/a.ts', lines: 3 }])).toBeNull();
  });
});

describe('maxLane', () => {
  it('only goes up', () => {
    expect(maxLane('solo', 'standard')).toBe('standard');
    expect(maxLane('standard', 'solo')).toBe('standard');
  });
});

describe('epic breakdowns', () => {
  const doc = (said: number, headings: string[]) =>
    `---\nmilestones: ${said}\n---\n## Overview\nx\n\n## Milestones\n${headings.map((h) => `### ${h}\nDo it.`).join('\n\n')}\n\n## Not in these milestones\n- nothing`;

  it('reads the milestones in order', () => {
    expect(parseMilestones(doc(2, ['1. Setup', '2. Chat']))).toEqual([
      { title: 'Setup', body: 'Do it.' },
      { title: 'Chat', body: 'Do it.' },
    ]);
  });

  it('sends a breakdown back when the count and the headings disagree, or there are too many', () => {
    expect(validateDoc('splitting', doc(2, ['1. Setup', '2. Chat']))).toBeNull();
    expect(validateDoc('splitting', doc(3, ['1. Setup', '2. Chat']))).toContain('says 3 milestones but the Milestones section has 2');
    expect(validateDoc('splitting', doc(9, Array.from({ length: 9 }, (_, i) => `${i + 1}. P${i}`)))).toContain('front matter does not match');
  });
});
