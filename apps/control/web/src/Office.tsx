import { useEffect, useState } from 'react';
import { api, type Task } from './api';
import { StatusBadge } from './ui';

interface OfficeInfo {
  running: boolean;
  url: string | null;
  linked: boolean;
  /** Office width / height: on phones the frame takes this shape, so Fit leaves no empty bands. */
  aspect: number | null;
  start: string;
}

/**
 * The pixel office, live: residents work at their desks while office agents run. Embedded without
 * Pixel Agents' token, so it can't change Claude settings; it can still move or close characters and
 * edit the layout, like the pixel office itself.
 */
type Fit = 'contain' | 'cover';
const FIT_KEY = 'office.fit';

function savedFit(): Fit {
  try {
    return localStorage.getItem(FIT_KEY) === 'cover' ? 'cover' : 'contain';
  } catch {
    return 'contain';
  }
}

export function Office({ tasks, onError }: { tasks: Task[]; onError: (e: unknown) => void }) {
  const [info, setInfo] = useState<OfficeInfo | null>(null);
  // Fit: the whole office, scaled to the frame. Fill: no empty bands, edges cropped.
  const [fit, setFit] = useState<Fit>(savedFit);
  const chooseFit = (f: Fit) => {
    setFit(f);
    try {
      localStorage.setItem(FIT_KEY, f);
    } catch {
      // private mode: just don't remember it
    }
  };

  useEffect(() => {
    const load = () => api.office().then(setInfo).catch(onError);
    void load();
    const t = window.setInterval(load, 10_000);
    return () => window.clearInterval(t);
  }, [onError]);

  const active = tasks.filter((t) => t.running || t.column === 'Awaiting you');

  return (
    <div className={`office office-${fit}`} style={info?.aspect ? ({ '--office-aspect': String(info.aspect) } as React.CSSProperties) : undefined}>
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
        <div className="segmented-buttons" role="group" aria-label="Office size">
          <button className={fit === 'contain' ? 'active' : ''} onClick={() => chooseFit('contain')} title="Show the whole office">
            Fit
          </button>
          <button className={fit === 'cover' ? 'active' : ''} onClick={() => chooseFit('cover')} title="Fill the frame; edges may be cropped">
            Fill
          </button>
        </div>
        {info && !info.linked && info.running && (
          <p className="hint">Start the pixel office with {info.start} so office agents appear in it.</p>
        )}
      </aside>
      {info?.running && info.url ? (
        // ?embed: no toolbars, and the scene scales itself to this frame (see apps/pixel embed.ts).
        <iframe className="office-frame" src={`${info.url}?embed&fit=${fit}`} title="Pixel office" />
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
