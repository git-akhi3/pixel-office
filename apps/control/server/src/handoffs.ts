// Handoff documents: what each step must output, how big it may be, and how it is stored.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export type DocName = 'task' | 'diagnosis' | 'research' | 'brief' | 'plan' | 'changes' | 'blocked' | 'pr' | 'review' | 'test-report' | 'retro' | 'pr-review';

export interface Contract {
  doc: DocName;
  /** Max body lines (front matter excluded). Output over this is sent back once for trimming. */
  maxLines: number;
  schema: z.ZodType;
  format: string;
}

const bool = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]);

export const CONTRACTS = {
  intake: {
    doc: 'task',
    maxLines: 40,
    schema: z.object({
      title: z.string().min(1).max(80),
      kind: z.enum(['feature', 'bug']),
      size: z.enum(['S', 'M', 'L']),
      needs_debugger: bool,
      needs_researcher: bool,
      design_review: bool,
      /** Catalog skills per role, for roles the owner left empty. Checked against the catalog afterwards. */
      // Hints, not requirements: a malformed value is ignored rather than failing the intake.
      skills: z.unknown().optional().catch(undefined),
      skills_why: z.unknown().optional().catch(undefined),
      /** Whether the architect should grill the owner before planning (used when the mission is on Auto). */
      grill: bool.optional().catch(undefined),
      grill_reason: z.coerce.string().max(300).optional().catch(undefined),
    }),
    format: `---
title: <short task title, under 60 characters>
kind: feature | bug
size: S | M | L          # S: under an hour of focused work, M: half a day, L: more
needs_debugger: true | false    # true only for bugs whose cause is unclear
needs_researcher: true | false  # true only if external docs/APIs must be checked first
design_review: true | false     # true for UI or architecture changes: the plan gets a design section
skills:                  # optional: catalog skills for roles the owner hasn't picked; leave out when none fit
  coder: [skill-name]
skills_why:              # one line per role you picked for
  coder: <why this skill fits this task>
grill: true | false      # true when the architect should interview the owner before planning (see the briefing rules)
grill_reason: <one line: why, or why not>
---
## Request
<the request restated in 2-4 lines, with anything ambiguous called out>

## Draft acceptance criteria
- <checkable criterion>

## Notes for the architect
- <optional, at most 5 bullets: relevant files, constraints you noticed>`,
  },
  debugging: {
    doc: 'diagnosis',
    maxLines: 60,
    schema: z.object({ reproduced: bool }),
    format: `---
reproduced: true | false
---
## Reproduction
<smallest command or test that shows the bug, and its output>

## Root cause
<what is wrong and where, with file:line>

## Evidence
- <what you ran or read that proves it>

## Fix area
<where a fix should go; do not write the fix>`,
  },
  researching: {
    doc: 'research',
    maxLines: 60,
    schema: z.object({}).passthrough(),
    format: `---
---
## Answers
- <question>: <answer> (<source URL>)

## Uncertain
- <anything the sources disagree on or do not cover>`,
  },
  planning: {
    doc: 'plan',
    maxLines: 100,
    schema: z.object({
      files_in_scope: z.array(z.string().min(1)).min(1),
      token_estimate: z.coerce.number().int().positive(),
    }),
    format: `---
files_in_scope:          # every file the coder may create or change (globs allowed, e.g. src/auth/**)
  - path/to/file.ts
token_estimate: 150000   # your estimate of total tokens for coding + review + tests
---
## Goal
<one or two lines>

## Acceptance criteria
- <checkable by a test or command>

## Steps
1. <file: what changes, which existing helpers to reuse>

## Out of scope
- <what not to touch>

## Risks
- <risk, or open question and the conservative choice you made>

## Design
<only when design review is requested: approach, alternatives rejected and why>

Keep the body under 80 lines.`,
  },
  coding: {
    doc: 'changes',
    maxLines: 60,
    schema: z.object({ status: z.enum(['done', 'blocked']) }),
    format: `When the work is done:
---
status: done
---
## Changes
- Step <n>: <what changed, file names>

## Deviations
- <any deviation from the plan and why, or "none">

## Commands run
- <command>: <result>

## PR
**Title:** <under 70 chars>
**Summary:**
- <what and why, at most 3 bullets>
**How it was tested:** <commands and results>

When you cannot follow the plan (it is wrong, incomplete, or needs files outside its scope):
---
status: blocked
---
## Question
<the one thing you need decided>

## What I tried
- <...>

## Options
1. <option and its consequence>`,
  },
  reviewing: {
    doc: 'review',
    maxLines: 60,
    schema: z.object({ verdict: z.enum(['pass', 'fail']), blocking: z.coerce.number().int().min(0) }),
    format: `---
verdict: pass | fail     # fail if there is at least one blocking finding
blocking: <number of blocking findings>
---
## Summary
<one or two lines>

## Findings
- [blocking] path/to/file.ts:42 — <one line: what is wrong and why it matters>
- [suggestion] path:line — <...>
- [nit] path:line — <...>

No findings? Write "- none".`,
  },
  testing: {
    doc: 'test-report',
    maxLines: 70,
    schema: z.object({ result: z.enum(['pass', 'fail']), tests_added: z.coerce.number().int().min(0) }),
    format: `---
result: pass | fail
tests_added: <number>
---
## Tests added
- path/to/file.test.ts: <what it covers, mapped to acceptance criteria>

## Suite
<command>: <summary line, e.g. 120 passed, 2 failed>

## Failing output
<only when failing: the relevant failure output, trimmed to 40 lines>`,
  },
  reviewing_pr: {
    doc: 'pr-review',
    maxLines: 80,
    schema: z.object({ verdict: z.enum(['approve', 'comment', 'request_changes']) }),
    format: `---
verdict: approve | comment | request_changes   # your recommendation; the owner posts it as a comment review
---
## Summary
<2-5 lines for the PR author: what the PR does, overall assessment, the most important issue>

## Comments
- [blocking] path/to/file.ts:42 — <one or two sentences: what is wrong, why it matters, what to do>
- [suggestion] path/to/file.ts:57 — <...>
- [nit] path/to/file.ts:60 — <...>

Rules: use paths and NEW-side line numbers from the diff. Comment only on lines the PR adds or changes,
or on context lines inside its hunks. No praise-only comments. No findings? Write "- none".`,
  },
  retro: {
    doc: 'retro',
    maxLines: 10,
    schema: z.object({}).passthrough(),
    format: `---
---
- **Went well:** <one line>
- **Went wrong:** <one line>
- **Knowledge-file edit:** <one line to add to this repo's notes, or "none">`,
  },
} satisfies Record<string, Contract>;

export type ContractStep = keyof typeof CONTRACTS;

export interface ParsedDoc {
  meta: Record<string, unknown>;
  body: string;
  raw: string;
}

/** Strips a wrapping ```markdown fence and leading chatter before the front matter. */
export function normalizeOutput(text: string): string {
  let t = text.trim();
  const fenced = t.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/);
  if (fenced) t = fenced[1]!.trim();
  const fm = t.indexOf('---\n');
  if (fm > 0 && fm < 400) t = t.slice(fm);
  return t;
}

export function parseDoc(text: string): ParsedDoc {
  const raw = normalizeOutput(text);
  const m = raw.match(/^---\n([\s\S]*?)\n?---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw, raw };
  const meta = (parseYaml(m[1]!) ?? {}) as Record<string, unknown>;
  return { meta: typeof meta === 'object' ? meta : {}, body: m[2]!.trim(), raw };
}

/** Returns a correction message for the agent, or null when the output meets its contract. */
export function validateDoc(step: ContractStep, text: string): string | null {
  const contract: Contract = CONTRACTS[step];
  if (!text.trim()) return 'Your final message was empty. Reply with only the handoff document in the required format.';
  let parsed: ParsedDoc;
  try {
    parsed = parseDoc(text);
  } catch (e) {
    return `The front matter is not valid YAML (${(e as Error).message}). Reply with the whole document again, fixed.`;
  }
  const meta = contract.schema.safeParse(parsed.meta);
  if (!meta.success) {
    const issues = meta.error.issues.map((i) => `${i.path.join('.') || 'front matter'}: ${i.message}`).join('; ');
    return `The front matter does not match the required format (${issues}). Reply with the whole document again, fixed. Required format:\n\n${contract.format}`;
  }
  const lines = parsed.body.split('\n').length;
  if (lines > contract.maxLines) {
    return `The document is ${lines} lines; the limit is ${contract.maxLines}. Reply with the whole document again, shortened. Keep every required field.`;
  }
  return null;
}

export function readMeta<T>(step: ContractStep, text: string): T {
  return (CONTRACTS[step] as Contract).schema.parse(parseDoc(text).meta) as T;
}

/** The "## PR" section of the coder's changes.md, used as the PR body. */
export function extractPr(changes: string): { title: string; body: string } | null {
  const section = parseDoc(changes).body.split(/^## PR\s*$/m)[1];
  if (!section) return null;
  const title = section.match(/\*\*Title:\*\*\s*(.+)/)?.[1]?.trim();
  if (!title) return null;
  const body = section
    .replace(/\*\*Title:\*\*.*\n?/, '')
    .replace(/^## .*$[\s\S]*/m, '')
    .trim();
  return { title: title.slice(0, 120), body };
}

// ---------------------------------------------------------------- storage

export class TaskDocs {
  constructor(private tasksDir: string) {}

  dir(taskId: number): string {
    const d = join(this.tasksDir, String(taskId));
    mkdirSync(d, { recursive: true });
    return d;
  }

  /** Saves a new version as name.N.md and refreshes name.md, which is always the latest. */
  save(taskId: number, name: DocName, content: string): string {
    const dir = this.dir(taskId);
    const version = this.versions(taskId, name).length + 1;
    writeFileSync(join(dir, `${name}.${version}.md`), content);
    writeFileSync(join(dir, `${name}.md`), content);
    return join(dir, `${name}.md`);
  }

  latest(taskId: number, name: DocName): string | null {
    const f = join(this.dir(taskId), `${name}.md`);
    return existsSync(f) ? readFileSync(f, 'utf8') : null;
  }

  /** Numbered versions, oldest first. */
  versions(taskId: number, name: DocName): string[] {
    const re = new RegExp(`^${name}\\.(\\d+)\\.md$`);
    return readdirSync(this.dir(taskId))
      .filter((f) => re.test(f))
      .sort((a, b) => Number(a.match(re)![1]) - Number(b.match(re)![1]));
  }

  /** Every saved version, grouped by document. */
  list(taskId: number): Array<{ file: string; name: string; version: number }> {
    return readdirSync(this.dir(taskId))
      .map((file) => file.match(/^([\w-]+)\.(\d+)\.md$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => ({ file: m[0], name: m[1]!, version: Number(m[2]) }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.version - b.version);
  }

  read(taskId: number, file: string): string | null {
    if (!/^[\w-]+(\.\d+)?\.md$/.test(file)) return null;
    const f = join(this.dir(taskId), file);
    return existsSync(f) ? readFileSync(f, 'utf8') : null;
  }
}
