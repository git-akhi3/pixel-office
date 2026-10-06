import type { Task } from './api';
import { Icon, type IconName } from './icons';
import { COLUMNS, formatTokens, LANE_HINT, StageTrack, StatusBadge, timeAgo } from './ui';

const LANES: Record<string, { icon: IconName; tone: string }> = {
  Queued: { icon: 'clock', tone: 'muted' },
  Planning: { icon: 'architect', tone: 'cyan' },
  'Awaiting you': { icon: 'warn', tone: 'attention' },
  Building: { icon: 'coder', tone: 'active' },
  'Review/Test': { icon: 'reviewer', tone: 'pink' },
  Done: { icon: 'check', tone: 'done' },
};

export function Board({
  tasks,
  repoName,
  activity,
  onAssign,
}: {
  tasks: Task[];
  repoName: (id: number) => string;
  activity: Record<number, string>;
  onAssign: () => void;
}) {
  const visible = tasks.filter((t) => t.status !== 'discarded');
  const running = visible.filter((t) => t.running).length;
  const waiting = visible.filter((t) => t.column === 'Awaiting you' || t.pendingGates.length > 0).length;
  const done = visible.filter((t) => t.column === 'Done').length;

  return (
    <div className="board-page">
      <header className="page-head">
        <h1>Mission board</h1>
        <div className="stats">
          <span className="stat stat-active">
            <strong>{running}</strong> in progress
          </span>
          <span className={`stat stat-attention${waiting ? ' stat-lit' : ''}`}>
            <strong>{waiting}</strong> need you
          </span>
          <span className="stat stat-done">
            <strong>{done}</strong> done
          </span>
        </div>
      </header>
      {visible.length === 0 ? (
        <div className="hero">
          <Icon name="flag" size={48} />
          <h2>No missions yet</h2>
          <p>Hand the team a task: they plan it, build it, review it and test it. You approve the plan and the push.</p>
          <button className="primary big" onClick={onAssign}>
            <Icon name="flag" /> Assign the first mission
          </button>
        </div>
      ) : (
        <div className="board">
          {COLUMNS.map((col) => {
            const items = visible.filter((t) => t.column === col);
            const lane = LANES[col] ?? { icon: 'board' as IconName, tone: 'muted' };
            return (
              <section key={col} className={`lane lane-${lane.tone}${items.length === 0 ? ' is-empty' : ''}`}>
                <h2 className="lane-head">
                  <Icon name={lane.icon} />
                  <span>{col}</span>
                  <span className="count">{items.length}</span>
                </h2>
                <div className="lane-body">
                  {items.length === 0 && <p className="lane-empty">Empty</p>}
                  {items.map((t) => (
                    <a key={t.id} className={`card${t.running ? ' card-live' : ''}`} href={`#/task/${t.id}`}>
                      <div className="card-top">
                        <span className="task-id">#{t.id}</span>
                        <span className="repo-chip">{repoName(t.repoId)}</span>
                        {t.kind !== 'feature' && <span className={`kind kind-${t.kind}`}>{t.kind}</span>}
                        {t.size && <span className="size" title={`Size ${t.size}`}>{t.size}</span>}
                        {t.lane && t.lane !== 'standard' && <span className="tag" title={`${t.lane} lane: ${LANE_HINT[t.lane]}`}>{t.lane}</span>}
                        {t.parentId && <span className="tag" title={`Milestone of #${t.parentId}`}>of #{t.parentId}</span>}
                      </div>
                      <div className="card-title">{t.title}</div>
                      <StageTrack task={t} />
                      <StatusBadge status={t.status} running={t.running} />
                      {t.pendingGates.some((g) => g.kind === 'question') && (
                        <div className="card-alert">
                          <Icon name="question" size={8} /> The architect has questions for you
                        </div>
                      )}
                      {t.pendingGates.some((g) => g.kind === 'command') && (
                        <div className="card-alert">
                          <Icon name="warn" size={8} /> Command waiting for approval
                        </div>
                      )}
                      {t.running && activity[t.id] && <div className="card-activity">{activity[t.id]}</div>}
                      {t.statusNote && <div className="card-note">{t.statusNote}</div>}
                      <div className="card-meta">
                        <span>{timeAgo(t.updatedAt)}</span>
                        {t.tokens > 0 && <span>{formatTokens(t.tokens)} tokens</span>}
                        {t.loopCount > 0 && <span>loop {t.loopCount}</span>}
                      </div>
                    </a>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
