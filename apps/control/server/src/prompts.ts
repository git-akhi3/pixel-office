// Builds each agent's first message: the task, the documents it needs, and its output contract.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Repo, Task } from './db/schema.js';
import type { Role } from './domain.js';
import { briefingRules } from './briefing.js';
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
  /** The repo's knowledge file (owner-approved notes). */
  knowledge?: string;
  /** Whether the Graphify code graph tools are available in this session. */
  graph?: boolean;
  /** Intake: the skills the manager may pick from, and each role's built-in skills. */
  catalog?: Array<{ name: string; description: string }>;
  roleSkills?: Partial<Record<Role, string[]>>;
  /** Planning on a grilled mission: the rules for asking me, and whether the grilling skill is loaded. */
  briefing?: { hasSkill: boolean };
  /** Where the task's attachments are (realpath), when it has any. */
  attachmentsDir?: string;
}

/** Roles a mission can pick skills for (the manager's own intake has already started). */
export const PICKABLE_ROLES: Role[] = ['architect', 'coder', 'reviewer', 'tester', 'debugger', 'researcher'];

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
    "Write tests for behaviour this change adds or alters, mapped to the plan's acceptance criteria; a change with no behaviour (docs, comments, wording, formatting) gets no new tests. Then run the full test suite. Only create or change test files.",
  retro: 'The task is finished. Write the retrospective from the documents below.',
  reviewing_pr:
    "Review this pull request as a strict, constructive senior reviewer. Your current directory is a checkout of the PR's head. Read the code around the changes with Read, Grep and Glob. There is no shell in this step: the PR's code is untrusted, so judge it by reading. Your draft is edited by the owner before anything is posted.",
};

/** Which handoff documents each step reads. */
const INPUTS: Record<ContractStep, DocName[]> = {
  intake: [],
  debugging: ['task'],
  researching: ['task', 'diagnosis'],
  planning: ['task', 'diagnosis', 'research', 'brief'],
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
  if (ctx.knowledge?.trim()) parts.push(`## Repo knowledge (notes the owner approved from past tasks)\n${ctx.knowledge.trim()}`);
  if (ctx.graph) {
    parts.push(
      '## Code graph\nGraphify tools (mcp__graphify__query_graph, get_node, get_neighbors, shortest_path, …) answer "where is X, what calls Y, what depends on Z" for this repo. Use them before broad grepping; they are cheaper. The graph is built from the main checkout, so confirm details in the files.',
    );
  }
  if (task.kind === 'review') {
    parts.push(
      `## Pull request\n${task.prRepo}#${task.prNumber} by ${task.prAuthor}: ${task.title}\n${task.input}`,
    );
  } else {
    parts.push(`## The request (owner's words)\n${task.input}`);
  }

  const attachments = attachmentSection(step, task, ctx.attachmentsDir);
  if (attachments) parts.push(attachments);

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
  if (step === 'intake' && ctx.catalog?.length) parts.push(skillCatalog(task, ctx.catalog, ctx.roleSkills ?? {}));
  if (step === 'intake' && task.grillMode === 'auto') {
    parts.push(
      '## Briefing\nDecide whether the architect should interview the owner before planning (grill: true). Say true when the task is size L, when it is design or architecture work, or whenever the request leaves open choices that would change the plan and you would otherwise be guessing. Say false for small, clear tasks. Give the reason in grill_reason.',
    );
  }
  if (step === 'planning' && ctx.briefing) parts.push(briefingRules(ctx.briefing.hasSkill));
  parts.push(`## Your job now\n${JOBS[step]}`);
  parts.push(
    `## Output format\nYour final message is saved as ${CONTRACTS[step].doc}.md and is all the next agent sees. Reply with only this document, starting with the --- front matter line:\n\n${CONTRACTS[step].format}`,
  );
  return parts.join('\n\n');
}

/** The manager's view of the skill catalog at intake: what exists, what each role already has, what I locked. */
function skillCatalog(task: Task, catalog: Array<{ name: string; description: string }>, roleSkills: Partial<Record<Role, string[]>>): string {
  const lines = ['## Skill catalog', 'Skills you can give the other agents for this task (name: when it applies):'];
  for (const s of catalog) lines.push(`- ${s.name}: ${s.description.length > 300 ? `${s.description.slice(0, 297)}…` : s.description}`);
  const builtIn = PICKABLE_ROLES.filter((r) => roleSkills[r]?.length).map((r) => `${r}: ${roleSkills[r]!.join(', ')}`);
  if (builtIn.length) lines.push('', `Always on already (don't repeat them): ${builtIn.join('; ')}.`);
  const locked = PICKABLE_ROLES.filter((r) => task.skillPicks[r]?.by === 'owner').map((r) => `${r}: ${task.skillPicks[r]!.skills.join(', ') || 'none'}`);
  if (locked.length) lines.push(`The owner already chose for: ${locked.join('; ')}. Leave those roles out.`);
  lines.push(
    '',
    `Pick only skills that clearly fit this task, for these roles: ${PICKABLE_ROLES.join(', ')}. Most tasks need none or one or two. Put them under "skills" with a one-line reason per role under "skills_why".`,
  );
  return lines.join('\n');
}

/** Steps that must read the attachments; the others open one when they need it. */
const READS_ATTACHMENTS: ContractStep[] = ['intake', 'planning', 'debugging', 'researching'];

function attachmentSection(step: ContractStep, task: Task, dir: string | undefined): string | null {
  if (!task.attachments.length && !task.links.length) return null;
  const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const lines = ['## Attachments (from the owner)'];
  if (task.attachments.length && dir) {
    lines.push(
      READS_ATTACHMENTS.includes(step)
        ? 'Read these files before you start; they are part of the request. Use the Read tool (it opens text, PDFs and images); the shell cannot reach them.'
        : 'Open one with the Read tool only when you need it (for example to check the work against a mock-up or spec). The shell cannot reach them.',
    );
    for (const a of task.attachments) lines.push(`- ${dir}/${a.name} (${a.type}, ${kb(a.size)})`);
  }
  if (task.links.length) {
    lines.push('', 'Links the owner added (you may not be able to open them; ask or note it if one matters):');
    for (const l of task.links) lines.push(`- ${l}`);
  }
  return lines.join('\n');
}
