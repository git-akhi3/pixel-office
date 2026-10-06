import { describe, expect, it } from 'vitest';
import { maxLane } from '../server/src/domain.js';
import { isDocFile, laneAtIntake, laneOfDiff, SMALL_MAX_FILES } from '../server/src/lanes.js';

const facts = { size: 'S' as const, needsDebugger: false, needsResearcher: false, designFlag: false, grill: false };

describe('isDocFile', () => {
  it('knows prose files from code', () => {
    for (const f of ['README.md', 'docs/guide.mdx', 'notes.txt', 'LICENSE', 'CHANGELOG', 'pkg/README.rst']) expect(isDocFile(f)).toBe(true);
    for (const f of ['src/app.ts', 'package.json', 'config.yml', 'Makefile', 'readme.ts']) expect(isDocFile(f)).toBe(false);
  });
});

describe('laneAtIntake', () => {
  it("takes the manager's lane for a plain S task", () => {
    expect(laneAtIntake({ ...facts, said: 'trivial' }).lane).toBe('trivial');
    expect(laneAtIntake({ ...facts, said: 'small' }).lane).toBe('small');
  });

  it('is standard when the manager said nothing', () => {
    expect(laneAtIntake(facts)).toEqual({ lane: 'standard', reason: 'The manager gave no lane.' });
  });

  it('overrules the manager when the architect is needed', () => {
    expect(laneAtIntake({ ...facts, said: 'trivial', size: 'M' })).toMatchObject({ lane: 'standard', reason: expect.stringContaining('size M') });
    expect(laneAtIntake({ ...facts, said: 'small', grill: true }).reason).toContain('briefing');
    expect(laneAtIntake({ ...facts, said: 'small', needsDebugger: true }).lane).toBe('standard');
    expect(laneAtIntake({ ...facts, said: 'small', needsResearcher: true }).lane).toBe('standard');
    expect(laneAtIntake({ ...facts, said: 'small', designFlag: true }).lane).toBe('standard');
  });
});

describe('laneOfDiff', () => {
  it('keeps a short docs-only change trivial', () => {
    expect(laneOfDiff([{ file: 'README.md', lines: 3 }]).lane).toBe('trivial');
    expect(laneOfDiff([]).lane).toBe('trivial');
  });

  it('calls any code change, or long docs, small', () => {
    expect(laneOfDiff([{ file: 'README.md', lines: 1 }, { file: 'src/a.ts', lines: 1 }])).toEqual({ lane: 'small', reason: 'it changed code: src/a.ts' });
    expect(laneOfDiff([{ file: 'docs/guide.md', lines: 120 }]).lane).toBe('small');
  });

  it('calls a big change standard', () => {
    expect(laneOfDiff([{ file: 'src/a.ts', lines: 201 }]).lane).toBe('standard');
    expect(laneOfDiff(Array.from({ length: SMALL_MAX_FILES + 1 }, (_, i) => ({ file: `src/${i}.ts`, lines: 1 }))).lane).toBe('standard');
  });
});

describe('maxLane', () => {
  it('only goes up', () => {
    expect(maxLane('trivial', 'small')).toBe('small');
    expect(maxLane('standard', 'trivial')).toBe('standard');
  });
});
