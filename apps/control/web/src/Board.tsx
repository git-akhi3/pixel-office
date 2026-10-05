import type { Task } from './api';
import { COLUMNS, formatTokens, StatusBadge, timeAgo } from './ui';

export function Board({ tasks, repoName }: { tasks: Task[]; repoName: (id: number) => string }) {
  const visible = tasks.filter((t) => t.status !== 'discarded');
  return (
    <div className="board">
      {COLUMNS.map((col) => {
        const items = visible.filter((t) => t.column === col);
        return (
          <section key={col} className={`column ${col === 'Awaiting you' ? 'column-attention' : ''}`}>
            <h2>
              {col} <span className="count">{items.length}</span>
            </h2>
            {items.length === 0 && <p className="empty">Nothing here</p>}
            {items.map((t) => (
              <a key={t.id} className="card" href={`#/task/${t.id}`}>
                <div className="card-top">
                  <span className="task-id">#{t.id}</span>
                  <span className="repo-chip">{repoName(t.repoId)}</span>
                  {t.size && <span className="size">{t.size}</span>}
                </div>
                <div className="card-title">{t.title}</div>
                <StatusBadge status={t.status} running={t.running} />
                {t.pendingGates.some((g) => g.kind === 'command') && <div className="card-alert">Command waiting for approval</div>}
                {t.statusNote && <div className="card-note">{t.statusNote}</div>}
                <div className="card-meta">
                  <span>{timeAgo(t.updatedAt)}</span>
                  {t.tokens > 0 && <span>{formatTokens(t.tokens)} tokens</span>}
                  {t.loopCount > 0 && <span>loop {t.loopCount}</span>}
                </div>
              </a>
            ))}
          </section>
        );
      })}
    </div>
  );
}
