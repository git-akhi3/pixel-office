// How the office's Slack messages are laid out, for a phone screen: the ask first, a few lines of
// what matters, the buttons right under it, and the full document one tap away on the board.
// Pure functions of the task rows and handoff documents, so they can be tested without Slack.

import type { Task } from './db/schema.js';
import { extractPr, parseDoc, parseMilestones } from './handoffs.js';
import { boardColumn, type TaskStatus } from './domain.js';
import { clip, esc, tokens } from './slackStatus.js';

/** One line of markdown as Slack mrkdwn: **bold** becomes *bold*, and the text is escaped. */
export function inline(text: string): string {
  return esc(text.replace(/\s+/g, ' ').trim()).replace(/\*\*(.+?)\*\*/g, '*$1*');
}

/** The text under a `## Heading` of a document body, or '' when it has none. */
export function section(body: string, heading: string): string {
  const parts = body.split(new RegExp(`^## ${heading}\\s*$`, 'mi'));
  return parts[1]?.split(/^## /m)[0]?.trim() ?? '';
}

/** The bullet or numbered items of a section, one string each; "none" and empty items are dropped. */
export function items(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/)?.[1]?.trim() ?? '')
    .filter((l) => l && !/^none\b/i.test(l));
}

/** Up to `max` bullets, then "+N more". */
function bullets(list: string[], max: number, width: number): string {
  const shown = list.slice(0, max).map((l) => `• ${clip(inline(l), width)}`);
  if (list.length > max) shown.push(`_+${list.length - max} more on the board_`);
  return shown.join('\n');
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ------------------------------------------------------------ gate bodies

/** The plan in five short lines: goal, what "done" means, what it touches, what to watch. */
export function planSummary(doc: string): string {
  const { meta, body } = parseDoc(doc);
  const out: string[] = [];
  const goal = section(body, 'Goal');
  if (goal) out.push(`*Goal*\n${clip(inline(goal), 240)}`);
  const checks = items(section(body, 'Acceptance criteria'));
  if (checks.length) out.push(`*Done when* (${plural(checks.length, 'check')})\n${bullets(checks, 3, 120)}`);
  const files = Array.isArray(meta.files_in_scope) ? meta.files_in_scope.map(String) : [];
  const estimate = Number(meta.token_estimate) || 0;
  const touches = [files.length ? `${plural(files.length, 'file')}: ${files.slice(0, 3).map((f) => `\`${f.split('/').pop()}\``).join(', ')}${files.length > 3 ? ` +${files.length - 3}` : ''}` : '', estimate ? `~${tokens(estimate)} tokens` : ''].filter(Boolean);
  if (touches.length) out.push(`*Touches*\n${touches.join(' · ')}`);
  const risks = items(section(body, 'Risks'));
  if (risks.length) out.push(`*Watch out*\n${bullets(risks, 2, 140)}`);
  return out.join('\n\n');
}

/** The epic's split: the end state, then the milestones in order. */
export function breakdownSummary(doc: string): string {
  const overview = section(parseDoc(doc).body, 'Overview');
  const milestones = parseMilestones(doc);
  const out: string[] = [];
  if (overview) out.push(clip(inline(overview), 240));
  if (milestones.length) {
    const list = milestones.slice(0, 8).map((m, i) => `${i + 1}. ${clip(inline(m.title), 70)}`);
    if (milestones.length > 8) list.push(`_+${milestones.length - 8} more on the board_`);
    out.push(`*${plural(milestones.length, 'milestone')}*\n${list.join('\n')}`);
  }
  return out.join('\n\n');
}

/** The open PR waiting for my OK to merge: its link, then what pushSummary shows. */
export function mergeSummary(prUrl: string | null, docs: { changes?: string | null; review?: string | null; testReport?: string | null }): string {
  return [prUrl ? `<${prUrl}|Open the PR>` : null, pushSummary(docs)].filter(Boolean).join('\n\n');
}

/** What the push will open: the PR title and summary, and how review and tests went. */
export function pushSummary(docs: { changes?: string | null; review?: string | null; testReport?: string | null }): string {
  const out: string[] = [];
  const pr = docs.changes ? extractPr(docs.changes) : null;
  if (pr) {
    const summary = items(pr.body.split(/\*\*How it was tested/)[0]!.replace(/\*\*Summary:\*\*/, ''));
    out.push(`*${clip(inline(pr.title), 100)}*${summary.length ? `\n${bullets(summary, 3, 120)}` : ''}`);
  }
  const checks: string[] = [];
  if (docs.review) {
    const { verdict, blocking } = parseDoc(docs.review).meta;
    checks.push(verdict === 'pass' ? ':white_check_mark: Review passed' : `:warning: Review: ${Number(blocking) || 0} blocking`);
  }
  if (docs.testReport) {
    const { result, tests_added: added } = parseDoc(docs.testReport).meta;
    const n = Number(added) || 0;
    checks.push(result === 'pass' ? `:white_check_mark: Tests passed${n ? ` (+${n} new)` : ''}` : ':x: Tests failing');
  }
  if (checks.length) out.push(checks.join('  ·  '));
  return out.join('\n\n');
}

/** A draft PR review, before the owner posts it: the verdict, the counts, the blocking comments. */
export function reviewPostSummary(doc: string): string {
  const { meta, body } = parseDoc(doc);
  const verdict = { approve: ':white_check_mark: Recommends approving', comment: ':speech_balloon: Comments only', request_changes: ':warning: Recommends changes' }[String(meta.verdict)] ?? '';
  const comments = items(section(body, 'Comments'));
  const count = (tag: string) => comments.filter((c) => c.toLowerCase().startsWith(`[${tag}]`)).length;
  const counts = [['blocking', count('blocking')], ['suggestion', count('suggestion')], ['nit', count('nit')]].filter(([, n]) => n).map(([k, n]) => `${n} ${k}`);
  const out: string[] = [];
  const head = [verdict, counts.join(', ')].filter(Boolean).join(' · ');
  if (head) out.push(`*${head}*`);
  const summary = section(body, 'Summary');
  if (summary) out.push(clip(inline(summary), 300));
  const blocking = comments.filter((c) => c.toLowerCase().startsWith('[blocking]')).map((c) => c.replace(/^\[blocking\]\s*/i, ''));
  if (blocking.length) out.push(`*Blocking*\n${bullets(blocking, 3, 160)}`);
  return out.join('\n\n');
}

// ------------------------------------------------------------ live checks

export type Verdict = 'pass' | 'fail' | 'partial';

export type CheckStage = 'build' | 'pr' | 'deployed';

const VERDICT_ICON: Record<Verdict, string> = { pass: ':white_check_mark:', fail: ':x:', partial: ':warning:' };
const VERDICT_WORD: Record<Verdict, string> = { pass: 'passed', fail: 'failed', partial: 'partly done' };
const STAGE_NAME: Record<CheckStage, string> = { build: 'Live check', pr: 'PR re-check', deployed: 'Production check' };

/** The thread message for a report from the desktop verifier, which runs what the office's agents can't. */
export function verificationText(verdict: Verdict, report: string, stage: CheckStage = 'build', sha?: string): string {
  const at = sha ? ` (\`${sha.slice(0, 7)}\`)` : '';
  return `${VERDICT_ICON[verdict]} ${STAGE_NAME[stage]} ${VERDICT_WORD[verdict]}${at}\n${clip(esc(report.trim()), 2000)}`;
}

// ------------------------------------------------------------ alerts

const ALERTS: Record<string, string> = {
  blocked: ':octagonal_sign: Blocked',
  tests_failing: ':x: Tests keep failing',
  loops_exhausted: ':x: Fixes did not work',
  scope: ':warning: Changes outside the plan',
  tokens: ':moneybag: Over budget',
  lane: ':arrow_up: Moved up a lane',
  rate_limit: ':hourglass_flowing_sand: Paused: rate limit',
  skills: ':information_source: Skills',
  knowledge: ':bulb: Suggested note for the repo',
  post_failed: ':x: Could not post',
};

/** An alert as a bold title and the detail under it. Command permissions are covered by their own gate message. */
export function alertText(kind: string, message: string): string | null {
  if (kind === 'permission') return null;
  const title = ALERTS[kind] ?? ':rotating_light: Heads up';
  return `${title}\n${clip(esc(message), 600)}`;
}

// ------------------------------------------------------------ status message

const STEP_LABEL: Partial<Record<TaskStatus, string>> = {
  queued: ':hourglass: Queued',
  intake: ':mag: Sizing it up',
  debugging: ':beetle: Finding the cause',
  researching: ':books: Researching',
  planning: ':memo: Planning',
  splitting: ':world_map: Splitting into milestones',
  awaiting_answer: ':question: Needs your answers',
  awaiting_plan_approval: ':raised_hand: Needs your OK on the plan',
  awaiting_breakdown_approval: ':raised_hand: Needs your OK on the milestones',
  coding: ':hammer_and_wrench: Building',
  reviewing: ':eyes: Reviewing the code',
  testing: ':test_tube: Testing',
  awaiting_push_approval: ':raised_hand: Needs your OK to push',
  pushing: ':rocket: Opening the PR',
  pr_open: ':rocket: Draft PR open',
  awaiting_merge_approval: ':raised_hand: PR open: needs your OK to merge',
  merging: ':twisted_rightwards_arrows: Merging',
  retro: ':thought_balloon: Wrapping up',
  reviewing_pr: ':eyes: Reviewing the PR',
  awaiting_review_post: ':raised_hand: Needs your OK to post the review',
  posting_review: ':outbox_tray: Posting the review',
  blocked: ':octagonal_sign: Blocked',
  paused: ':double_vertical_bar: Paused',
  stopped: ':double_vertical_bar: Stopped',
  done: ':white_check_mark: Done',
  failed: ':x: Failed',
  discarded: ':wastebasket: Discarded',
};

export function stepLabel(status: TaskStatus): string {
  return STEP_LABEL[status] ?? `${status.replace(/_/g, ' ')} (${boardColumn(status)})`;
}

/** "▰▰▰▱▱▱": how far along the pipeline a task is. Not a time estimate. */
export function progressBar(n: number, of: number): string {
  return '▰'.repeat(Math.min(n, of)) + '▱'.repeat(Math.max(of - n, 0));
}

export interface StatusView {
  task: Task;
  agent: string | null;
  /** Time in the current step, when an agent is working. */
  elapsed: string | null;
  stage: { n: number; of: number } | null;
  tokens: number;
}

/** The single status message: title, what is happening now, progress, then the small print. */
export function statusBlocks(v: StatusView): { text: string; blocks: unknown[] } {
  const { task } = v;
  const now = [stepLabel(task.status), v.agent ? `${v.agent} working${v.elapsed ? ` for ${v.elapsed}` : ''}` : ''].filter(Boolean);
  const lines = [`*#${task.id}* ${esc(clip(task.title, 90))}`, `*${now[0]}*${now[1] ? ` · ${now[1]}` : ''}`];
  if (v.stage) lines.push(`${progressBar(v.stage.n, v.stage.of)}  stage ${v.stage.n} of ${v.stage.of}`);
  if (task.statusNote) lines.push(`_${esc(clip(task.statusNote, 200))}_`);
  const small = [`${tokens(v.tokens)} tokens`, task.prUrl ? `<${task.prUrl}|PR>` : ''].filter(Boolean).join(' · ');
  const text = `#${task.id} ${esc(clip(task.title, 60))}: ${stepLabel(task.status).replace(/^:\w+:\s*/, '')}`;
  return {
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: small }] },
    ],
  };
}
