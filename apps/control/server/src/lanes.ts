// Lanes: how much of the team a task gets. The manager proposes one at intake; plain rules here
// overrule it when the task needs more, and the coder's real diff can only raise it. A wrong guess
// from the manager costs tokens, never a skipped review.

import { basename, extname } from 'node:path';
import type { Lane, TaskSize } from './domain.js';

/** A trivial change stays trivial only up to this many changed lines, all in doc files. */
export const TRIVIAL_MAX_LINES = 40;
/** Past either of these a change gets the standard checks, whatever the manager said. */
export const SMALL_MAX_LINES = 200;
export const SMALL_MAX_FILES = 8;

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc']);
/** Extensionless prose files. With an extension, only DOC_EXTENSIONS count: readme.ts is code. */
const DOC_NAMES = /^(readme|license|licence|changelog|changes|authors|contributors|notice|copying)$/i;

/** Prose files: changing them can't change what the code does. */
export function isDocFile(path: string): boolean {
  return DOC_EXTENSIONS.has(extname(path).toLowerCase()) || DOC_NAMES.test(basename(path));
}

export interface IntakeFacts {
  /** What the manager said (missing when it said nothing usable). */
  said?: Lane;
  size: TaskSize | null;
  needsDebugger: boolean;
  needsResearcher: boolean;
  designFlag: boolean;
  grill: boolean;
}

/** The lane a task starts in. Anything the architect has to handle is standard, whatever the manager said. */
export function laneAtIntake(f: IntakeFacts): { lane: Lane; reason: string } {
  const said = f.said ?? 'standard';
  if (said === 'standard') return { lane: 'standard', reason: f.said ? 'The manager routed it through the full team.' : 'The manager gave no lane.' };
  const needsArchitect = [
    [f.grill, 'it gets a briefing'],
    [f.needsDebugger, 'it needs the debugger'],
    [f.needsResearcher, 'it needs research'],
    [f.designFlag, 'it needs a design review'],
    [f.size !== 'S', `it is size ${f.size ?? 'unknown'}`],
  ] as const;
  const why = needsArchitect.find(([hit]) => hit)?.[1];
  if (why) return { lane: 'standard', reason: `The manager said ${said}, but ${why}.` };
  return { lane: said, reason: `The manager routed it as ${said}.` };
}

/** The smallest lane the coder's diff fits, and why. */
export function laneOfDiff(stat: Array<{ file: string; lines: number }>): { lane: Lane; reason: string } {
  const lines = stat.reduce((n, s) => n + s.lines, 0);
  const code = stat.filter((s) => !isDocFile(s.file)).map((s) => s.file);
  if (stat.length > SMALL_MAX_FILES) return { lane: 'standard', reason: `it changed ${stat.length} files` };
  if (lines > SMALL_MAX_LINES) return { lane: 'standard', reason: `it changed ${lines} lines` };
  if (code.length) return { lane: 'small', reason: `it changed code: ${code.slice(0, 3).join(', ')}${code.length > 3 ? '…' : ''}` };
  if (lines > TRIVIAL_MAX_LINES) return { lane: 'small', reason: `it changed ${lines} lines of docs` };
  return { lane: 'trivial', reason: stat.length ? `docs only, ${lines} lines` : 'no changes' };
}
