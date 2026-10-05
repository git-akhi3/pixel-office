import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export const STATUS_LABELS: Record<string, string> = {
  queued: 'Queued',
  intake: 'Manager sizing it',
  debugging: 'Debugger investigating',
  researching: 'Researcher looking it up',
  planning: 'Architect planning',
  awaiting_plan_approval: 'Plan ready for you',
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

export function statusTone(status: string): 'attention' | 'active' | 'done' | 'muted' | 'danger' {
  if (['awaiting_plan_approval', 'awaiting_push_approval', 'awaiting_review_post'].includes(status)) return 'attention';
  if (['blocked', 'failed'].includes(status)) return 'danger';
  if (['paused', 'stopped', 'discarded', 'queued'].includes(status)) return 'muted';
  if (['done', 'pr_open'].includes(status)) return 'done';
  return 'active';
}

export function StatusBadge({ status, running }: { status: string; running?: boolean }) {
  return (
    <span className={`badge badge-${statusTone(status)}`}>
      {running && <span className="pulse" aria-hidden />}
      {STATUS_LABELS[status] ?? status}
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
