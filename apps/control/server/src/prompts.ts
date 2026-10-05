// Builds each agent's first message: the task, the documents it needs, and its output contract.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Repo, Task } from './db/schema.js';
import { CONTRACTS, type ContractStep, type DocName, type TaskDocs } from './handoffs.js';

const MAX_REPO_NOTES = 6_000;
const MAX_DIFF = 60_000;

export interface PromptContext {
  task: Task;
  repo: Repo;
  docs: TaskDocs;
  worktree: string;
  /** Feedback for this step: my rejection comment, a blocker, review/test reports. */
  feedback?: string;
  diff?: string;
}

const JOBS: Record<ContractStep, string> = {
  intake:
    'Size and route this task. Skim the repo only as much as you need to judge it. Do not plan the implementation.',
  debugging: 'Find the root cause of this bug. Reproduce it first. Do not fix it.',
  researching: 'Answer the external questions this task depends on (libraries, APIs, docs), with sources.',
  planning:
    'Write the implementation plan. Read the relevant code first. The coder will follow it exactly and may only touch "files_in_scope".',
  coding:
    'Carry out the approved plan exactly. Run the lint, typecheck and test commands before you finish. If the plan cannot be followed, report status: blocked.',
  reviewing:
    'Review the changes (the diff below, and the code around it) against the plan. Run the tests if useful. You did not write this code.',
  testing:
    "Write tests for the plan's acceptance criteria, then run the full test suite. Only create or change test files.",
  retro: 'The task is finished. Write the retrospective from the documents below.',
  reviewing_pr:
    "Review this pull request as a strict, constructive senior reviewer. Your current directory is a checkout of the PR's head. Read the code around the changes. Do NOT run anything from the PR (no tests, builds, installs or scripts): its code is untrusted, so judge it by reading. Your draft is edited by the owner before anything is posted.",
};

/** Which handoff documents each step reads. */
const INPUTS: Record<ContractStep, DocName[]> = {
  intake: [],
  debugging: ['task'],
  researching: ['task', 'diagnosis'],
  planning: ['task', 'diagnosis', 'research'],
  coding: ['task', 'plan'],
  reviewing: ['plan', 'changes'],
  testing: ['plan', 'changes'],
  retro: ['task', 'plan', 'changes', 'review', 'test-report'],
  reviewing_pr: [],
};

function repoNotes(worktree: string): string | null {
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const f = join(worktree, name);
    if (existsSync(f)) {
      const text = readFileSync(f, 'utf8');
      return `### ${name}\n${text.length > MAX_REPO_NOTES ? `${text.slice(0, MAX_REPO_NOTES)}\n… (truncated; read the file for the rest)` : text}`;
    }
  }
  return null;
}

export function buildPrompt(step: ContractStep, ctx: PromptContext): string {
  const { task, repo, docs } = ctx;
  const parts: string[] = [];
  parts.push(`# Task #${task.id}: ${task.title}`);
  parts.push(
    [
      `Repository: ${repo.name}. Your current directory is the task's git worktree (${ctx.worktree}), on branch ${task.branch ?? '(new)'}, based on ${repo.defaultBranch}.`,
      `Commands: build: ${repo.buildCmd ?? 'none'} · test: ${repo.testCmd ?? 'none'} · lint: ${repo.lintCmd ?? 'none'}`,
      'Shell commands outside an allow-list pause until the owner approves them, so prefer the commands above and read-only git.',
    ].join('\n'),
  );
  const notes = repoNotes(ctx.worktree);
  if (notes) parts.push(`## Repo instructions\n${notes}`);
  if (task.kind === 'review') {
    parts.push(
      `## Pull request\n${task.prRepo}#${task.prNumber} by ${task.prAuthor}: ${task.title}\n${task.input}`,
    );
  } else {
    parts.push(`## The request (owner's words)\n${task.input}`);
  }

  const included = INPUTS[step]
    .map((name) => [name, docs.latest(task.id, name)] as const)
    .filter(([, text]) => text);
  if (included.length) {
    parts.push(
      `## Handoff documents\n${included.map(([name, text]) => `### ${name}.md\n${text}`).join('\n\n')}`,
    );
  }
  if (ctx.feedback) parts.push(`## Feedback to address\n${ctx.feedback}`);
  if (ctx.diff) {
    const d =
      ctx.diff.length > MAX_DIFF
        ? `${ctx.diff.slice(0, MAX_DIFF)}\n… (truncated; run git diff ${task.baseSha} for the rest)`
        : ctx.diff;
    parts.push(
      `## Diff against ${repo.defaultBranch} (base ${task.baseSha?.slice(0, 10)})\n\`\`\`diff\n${d}\n\`\`\``,
    );
  }
  if (step === 'planning' && task.designFlag) {
    parts.push(
      '## Design review\nThis task was flagged as UI or architecture work: include the Design section in the plan.',
    );
  }
  parts.push(`## Your job now\n${JOBS[step]}`);
  parts.push(
    `## Output format\nYour final message is saved as ${CONTRACTS[step].doc}.md and is all the next agent sees. Reply with only this document, starting with the --- front matter line:\n\n${CONTRACTS[step].format}`,
  );
  return parts.join('\n\n');
}
