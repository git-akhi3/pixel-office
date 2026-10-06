import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Task } from './api';
import { Icon, roleIconName } from './icons';

export const STATUS_LABELS: Record<string, string> = {
  queued: 'Queued',
  intake: 'Manager sizing it',
  debugging: 'Debugger investigating',
  researching: 'Researcher looking it up',
  planning: 'Architect planning',
  awaiting_answer: 'Architect asks you',
  awaiting_plan_approval: 'Plan ready for you',
  splitting: 'Architect splitting it into milestones',
  awaiting_breakdown_approval: 'Milestones ready for you',
  coding: 'Coder working',
  reviewing: 'Reviewer checking',
  testing: 'Tester testing',
  awaiting_push_approval: 'Ready to push',
  pushing: 'Pushing',
  pr_open: 'Draft PR open',
  retro: 'Writing retrospective',
  reviewing_pr: 'Reviewer reading the PR',
  awaiting_review_post: 'Draft review ready',
  posting_review: 'Posting review',
  done: 'Done',
  blocked: 'Blocked',
  paused: 'Paused',
  stopped: 'Stopped',
  failed: 'Failed',
  discarded: 'Discarded',
};

export const COLUMNS = ['Queued', 'Planning', 'Awaiting you', 'Building', 'Review/Test', 'Done'];

export type Tone = 'attention' | 'active' | 'done' | 'muted' | 'danger';

export function statusTone(status: string): Tone {
  if (['awaiting_answer', 'awaiting_plan_approval', 'awaiting_breakdown_approval', 'awaiting_push_approval', 'awaiting_review_post'].includes(status)) return 'attention';
  if (['blocked', 'failed'].includes(status)) return 'danger';
  if (['paused', 'stopped', 'discarded', 'queued'].includes(status)) return 'muted';
  if (['done', 'pr_open'].includes(status)) return 'done';
  return 'active';
}

/** The agent that works a status, mirroring AGENT_STEPS on the server. */
const STATUS_ROLES: Record<string, string> = {
  intake: 'manager',
  debugging: 'debugger',
  researching: 'researcher',
  planning: 'architect',
  splitting: 'architect',
  coding: 'coder',
  reviewing: 'reviewer',
  testing: 'tester',
  retro: 'manager',
  reviewing_pr: 'reviewer',
};

export function roleOf(status: string): string | null {
  return STATUS_ROLES[status] ?? null;
}

export function StatusBadge({ status, running }: { status: string; running?: boolean }) {
  const role = roleOf(status);
  return (
    <span className={`badge badge-${statusTone(status)}`}>
      {running && <span className="pulse" aria-hidden />}
      {role && <Icon name={roleIconName(role)} size={16} />}
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

// ------------------------------------------------------------------ mission stages

const BUILD_STAGES = ['Intake', 'Plan', 'Build', 'Review', 'Test', 'Ship'];
const REVIEW_STAGES = ['Read', 'Draft', 'Post'];

/** Where each status sits on the stage track. A position past the last stage means all done. */
const BUILD_POSITION: Record<string, number> = {
  intake: 0,
  debugging: 0,
  researching: 0,
  planning: 1,
  awaiting_answer: 1,
  awaiting_plan_approval: 1,
  splitting: 1,
  awaiting_breakdown_approval: 1,
  coding: 2,
  reviewing: 3,
  testing: 4,
  awaiting_push_approval: 5,
  pushing: 5,
  pr_open: 6,
  retro: 6,
  done: 6,
};
const REVIEW_POSITION: Record<string, number> = {
  reviewing_pr: 0,
  awaiting_review_post: 1,
  posting_review: 2,
  done: 3,
};

export interface Stage {
  stages: string[];
  /** Index of the current stage; -1 before the first, stages.length when all are done. */
  index: number;
  tone: Tone;
}

/** What each lane means, for tooltips. */
export const LANE_HINT: Record<string, string> = {
  trivial: 'docs or wording only, so no plan, review or tests; you approve the push',
  small: 'a small code change, so no architect; review and tests still run',
  standard: 'the full team',
};

/** Stages a lane skips: trivial tasks go straight from build to ship, small ones have no plan. */
const SKIPPED: Record<string, string[]> = { trivial: ['Plan', 'Review', 'Test'], small: ['Plan'] };

export function stageOf(task: Pick<Task, 'status' | 'resumeStatus' | 'kind' | 'lane'>): Stage {
  const review = task.kind === 'review';
  const position = review ? REVIEW_POSITION : BUILD_POSITION;
  // A parked task (paused, stopped, blocked) keeps its place: where it resumes from.
  const at = position[task.status] ?? (task.resumeStatus ? position[task.resumeStatus] : undefined) ?? -1;
  if (review) return { stages: REVIEW_STAGES, index: at, tone: statusTone(task.status) };
  const skipped = SKIPPED[task.lane ?? ''] ?? [];
  const stages = BUILD_STAGES.filter((s) => !skipped.includes(s));
  // The same position on the shorter track: count the kept stages before it.
  const index = at < 0 ? at : BUILD_STAGES.slice(0, at).filter((s) => !skipped.includes(s)).length;
  return { stages, index, tone: statusTone(task.status) };
}

/** The mission's stages as a row of pips: done, current (in the status colour), still to come. */
export function StageTrack({ task, labels }: { task: Pick<Task, 'status' | 'resumeStatus' | 'kind' | 'running' | 'lane'>; labels?: boolean }) {
  const { stages, index, tone } = stageOf(task);
  const current = stages[index];
  return (
    <div
      className={`stages${labels ? ' stages-labelled' : ''}`}
      role="img"
      aria-label={index >= stages.length ? 'All stages done' : current ? `Stage ${index + 1} of ${stages.length}: ${current}` : 'Not started'}
    >
      {stages.map((name, i) => (
        <span
          key={name}
          className={`stage ${i < index ? 'stage-done' : i === index ? `stage-now stage-${tone}${task.running ? ' stage-live' : ''}` : 'stage-todo'}`}
          title={name}
        >
          <span className="pip" />
          {labels && <span className="stage-name">{name}</span>}
        </span>
      ))}
    </div>
  );
}

/** A segmented meter, like a health bar. `value` is 0 to 1. */
export function Meter({ value, segments = 10, label, title }: { value: number; segments?: number; label?: string; title?: string }) {
  const filled = Math.max(0, Math.min(segments, Math.round(value * segments)));
  const level = value >= 0.9 ? 'high' : value >= 0.7 ? 'mid' : 'low';
  return (
    <span className={`meter meter-${level}`} title={title} role="img" aria-label={title ?? `${label ?? ''} ${Math.round(value * 100)}%`}>
      {label && <span className="meter-label">{label}</span>}
      <span className="meter-bar">
        {Array.from({ length: segments }, (_, i) => (
          <span key={i} className={i < filled ? 'on' : ''} />
        ))}
      </span>
      <span className="meter-value">{Math.round(value * 100)}%</span>
    </span>
  );
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function duration(ms: number | null): string {
  if (!ms) return '–';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function Doc({ text }: { text: string }) {
  // Front matter is shown as a compact table rather than raw YAML.
  const m = text.match(/^---\n([\s\S]*?)\n?---\n?([\s\S]*)$/);
  const meta = m?.[1]?.trim();
  const body = m ? m[2]! : text;
  return (
    <div className="doc">
      {meta && <pre className="frontmatter">{meta}</pre>}
      <Markdown remarkPlugins={[remarkGfm]}>{body}</Markdown>
    </div>
  );
}

export function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) return <p className="empty">No changes yet.</p>;
  return (
    <pre className="diff">
      {diff.split('\n').map((line, i) => {
        const cls = line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')
          ? 'diff-file'
          : line.startsWith('@@')
            ? 'diff-hunk'
            : line.startsWith('+')
              ? 'diff-add'
              : line.startsWith('-')
                ? 'diff-del'
                : '';
        return (
          <span key={i} className={cls}>
            {line}
            {'\n'}
          </span>
        );
      })}
    </pre>
  );
}
