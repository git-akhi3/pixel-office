import { useEffect, useState } from 'react';
import { api, type Task } from './api';
import { StatusBadge } from './ui';

interface OfficeInfo {
  running: boolean;
  url: string | null;
  linked: boolean;
  start: string;
}

/**
 * The pixel office, live: residents work at their desks while office agents run. Embedded without
 * Pixel Agents' token, so it can't change Claude settings; it can still move or close characters and
 * edit the layout, like the pixel office itself.
 */
export function Office({ tasks, onError }: { tasks: Task[]; onError: (e: unknown) => void }) {
  const [info, setInfo] = useState<OfficeInfo | null>(null);

  useEffect(() => {
    const load = () => api.office().then(setInfo).catch(onError);
    void load();
    const t = window.setInterval(load, 10_000);
    return () => window.clearInterval(t);
  }, [onError]);

  const active = tasks.filter((t) => t.running || t.column === 'Awaiting you');

  return (
    <div className="office">
      <aside className="office-side">
        <h2>Working now</h2>
        {active.length === 0 && <p className="empty">Nobody is working. Hand the team a task.</p>}
        {active.map((t) => (
          <a key={t.id} className="card" href={`#/task/${t.id}`}>
            <div className="card-top">
              <span className="task-id">#{t.id}</span>
            </div>
            <div className="card-title">{t.title}</div>
            <StatusBadge status={t.status} running={t.running} />
          </a>
        ))}
        {info && !info.linked && info.running && (
          <p className="hint">Start the pixel office with {info.start} so office agents appear in it.</p>
        )}
      </aside>
      {info?.running && info.url ? (
        <iframe className="office-frame" src={info.url} title="Pixel office" />
      ) : (
        <div className="panel office-off">
          <h1>The pixel office isn't running</h1>
          <p>
            Start it from the repo root with <code>{info?.start ?? 'npm run pixel'}</code>. This tab connects within a few seconds.
          </p>
          <p className="hint">Each running agent works at its resident desk, labelled with its task. A waiting bubble means a gate needs you.</p>
        </div>
      )}
    </div>
  );
}
