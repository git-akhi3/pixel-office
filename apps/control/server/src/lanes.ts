// Lanes: how much of the team a task gets. The all-rounder builds most tasks alone (solo); the full
// team is for work that needs a written plan first. The manager proposes a lane at intake, my own
// pick wins, and plain rules here send a task to the full team when it needs the architect.

import { basename, extname } from 'node:path';
import type { Lane, TaskSize } from './domain.js';

/** Past either of these (prose files don't count) a solo change gets one review on top. */
export const SMALL_MAX_LINES = 200;
export const SMALL_MAX_FILES = 8;

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc']);
/** Extensionless prose files. With an extension, only DOC_EXTENSIONS count: readme.ts is code. */
const DOC_NAMES = /^(readme|license|licence|changelog|changes|authors|contributors|notice|copying)$/i;

/** Markdown that steers agents (their instructions and skills) is code here, whatever its extension. */
const AGENT_FILES = /(^|\/)(CLAUDE|AGENTS|SKILL)\.md$|(^|\/)(\.claude|agents|skills|\.cursor|\.github)\//i;

/** Prose files: changing them can't change what the code (or an agent working on it) does. */
export function isDocFile(path: string): boolean {
  if (AGENT_FILES.test(path)) return false;
  return DOC_EXTENSIONS.has(extname(path).toLowerCase()) || DOC_NAMES.test(basename(path));
}

/** The lanes I can pick when I assign a mission (Auto leaves it to the manager). */
export const PICKABLE_LANES = ['solo', 'standard'] as const;
export type LanePick = (typeof PICKABLE_LANES)[number];

export interface IntakeFacts {
  /** What the manager said (missing when it said nothing usable). */
  said?: Lane;
  /** What I picked when I assigned the mission, if anything. */
  pick?: LanePick | null;
  size: TaskSize | null;
  designFlag: boolean;
  grill: boolean;
}

/**
 * The lane a task starts in. My pick wins over the manager's sizing, except that a briefing always
 * needs the architect (it asks the questions). Left to the manager, a design review or size L also
 * goes to the full team.
 */
export function laneAtIntake(f: IntakeFacts): { lane: Lane; reason: string } {
  if (f.pick === 'standard') return { lane: 'standard', reason: 'You asked for the full team.' };
  if (f.pick === 'solo') return f.grill ? { lane: 'standard', reason: 'You picked solo, but it gets a briefing.' } : { lane: 'solo', reason: 'You picked solo.' };
  const needsArchitect = [
    [f.grill, 'it gets a briefing'],
    [f.designFlag, 'it needs a design review'],
    [f.size === 'L', 'it is size L'],
  ] as const;
  const why = needsArchitect.find(([hit]) => hit)?.[1];
  // The lanes from before solo (trivial, small) mean the same thing now: no architect.
  const said = f.said === 'trivial' || f.said === 'small' ? 'solo' : f.said;
  if (said !== 'solo') return { lane: 'standard', reason: f.said ? 'The manager routed it through the full team.' : 'The manager gave no lane.' };
  if (why) return { lane: 'standard', reason: `The manager said solo, but ${why}.` };
  return { lane: 'solo', reason: 'The manager routed it as solo.' };
}

/** Why a solo change is big enough to get one review, or null when it isn't. Prose files don't count. */
export function reviewReason(stat: Array<{ file: string; lines: number }>): string | null {
  const code = stat.filter((s) => !isDocFile(s.file));
  const lines = code.reduce((n, s) => n + s.lines, 0);
  if (code.length > SMALL_MAX_FILES) return `it changed ${code.length} files`;
  if (lines > SMALL_MAX_LINES) return `it changed ${lines} lines`;
  return null;
}
