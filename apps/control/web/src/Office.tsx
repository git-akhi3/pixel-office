import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Task } from './api';
import { Icon, RoleIcon } from './icons';
import { StageTrack, StatusBadge } from './ui';

interface OfficeInfo {
  running: boolean;
  url: string | null;
  linked: boolean;
  aspect: number | null;
  start: string;
}

/** One character on duty, as the embedded office reports it (apps/pixel embedRoster.ts). */
interface RosterEntry {
  id: number;
  name: string;
  kind: 'resident' | 'agent' | 'sub';
  state: 'working' | 'approval' | 'waiting' | 'idle';
  /** What it is working on, e.g. "#3 Add item with category". */
  task?: string;
  /** What it is doing right now, e.g. "Running: npm test". */
  activity?: string;
}

type Fit = 'contain' | 'cover';
const FIT_KEY = 'office.fit';
const PANEL_KEY = 'office.live';

function saved(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode: just don't remember it
  }
}

/** Whether the live panel can sit beside the office (wide screens) or has to slide over it. */
const wideQuery = '(min-width: 1100px) and (orientation: landscape)';

const STATE_ORDER: Array<RosterEntry['state']> = ['approval', 'waiting', 'working', 'idle'];
const STATE_LABELS: Record<RosterEntry['state'], string> = {
  working: 'Working',
  approval: 'Needs approval',
  waiting: 'Waiting for input',
  idle: 'Idle',
};

/**
 * The pixel office, filling the page. Characters carry only a small name tag; who is doing what is
 * listed in the live panel, and hovering a row there points out the character. The office is embedded
 * without Pixel Agents' token, so it can't change Claude settings.
 */
export function Office({
  tasks,
  activity,
  immersive,
  onToggleImmersive,
  onAssign,
  onError,
}: {
  tasks: Task[];
  activity: Record<number, string>;
  immersive: boolean;
  onToggleImmersive: () => void;
  onAssign: () => void;
  onError: (e: unknown) => void;
}) {
  const [info, setInfo] = useState<OfficeInfo | null>(null);
  // Fit: the whole office, scaled to the page. Fill: no empty bands, edges cropped.
  const [fit, setFit] = useState<Fit>(() => (saved(FIT_KEY) === 'cover' ? 'cover' : 'contain'));
  const [panel, setPanel] = useState(() => {
    const pref = saved(PANEL_KEY);
    return pref === null ? window.matchMedia(wideQuery).matches : pref === '1';
  });
  const [roster, setRoster] = useState<RosterEntry[] | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const load = () => api.office().then(setInfo).catch(onError);
    void load();
    const t = window.setInterval(load, 10_000);
    return () => window.clearInterval(t);
  }, [onError]);

  const pixelOrigin = useMemo(() => (info?.running && info.url ? new URL(info.url).origin : null), [info]);

  // The embedded office posts who is on duty. Only its own origin is trusted.
  useEffect(() => {
    if (!pixelOrigin) return setRoster(null);
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== pixelOrigin || e.source !== frameRef.current?.contentWindow) return;
      const data = e.data as { source?: string; type?: string; agents?: RosterEntry[] } | null;
      if (data?.source !== 'pixel-agents-embed' || data.type !== 'roster' || !Array.isArray(data.agents)) return;
      setRoster(data.agents.filter((a) => typeof a?.id === 'number' && typeof a.name === 'string'));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [pixelOrigin]);

  const tell = useCallback(
    (message: { type: 'highlight'; id: number | null } | { type: 'hello' }) => {
      if (pixelOrigin) frameRef.current?.contentWindow?.postMessage({ source: 'pixel-office-board', ...message }, pixelOrigin);
    },
    [pixelOrigin],
  );
  const highlight = (id: number | null) => tell({ type: 'highlight', id });

  const togglePanel = () => {
    setPanel((open) => {
      save(PANEL_KEY, open ? '0' : '1');
      return !open;
    });
  };
  const toggleFit = () => {
    setFit((f) => {
      const next = f === 'contain' ? 'cover' : 'contain';
      save(FIT_KEY, next);
      return next;
    });
  };

  const active = tasks.filter((t) => t.running || t.column === 'Awaiting you' || t.pendingGates.length > 0);
  const needsYou = active.filter((t) => !t.running || t.pendingGates.length > 0);
  // Whoever needs me first, then the ones at work; open sessions that are idle go last.
  const onDuty = [...(roster ?? [])].sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state));
  const busy = onDuty.filter((a) => a.state !== 'idle').length;
  const src = pixelOrigin ? `${info!.url}?embed&fit=${fit}&parent=${encodeURIComponent(location.origin)}` : null;

  return (
    <div className={`office-page${panel ? ' panel-open' : ''}`}>
      <aside className="live-panel" aria-hidden={!panel}>
        <header className="live-head">
          <span className="live-title">
            <span className="pulse" aria-hidden /> Live
          </span>
          <button className="icon-btn" onClick={togglePanel} aria-label="Hide the live panel" title="Hide" tabIndex={panel ? 0 : -1}>
            <Icon name="left" />
          </button>
        </header>
        <div className="live-scroll">
          <h3>
            Missions <span className="count">{active.length}</span>
          </h3>
          {active.length === 0 && (
            <p className="empty">
              Nothing in flight.{' '}
              <button className="link" onClick={onAssign}>
                Assign a mission
              </button>
            </p>
          )}
          {active.map((t) => (
            <a key={t.id} className={`mission${t.running ? '' : ' mission-waiting'}`} href={`#/task/${t.id}`} tabIndex={panel ? 0 : -1}>
              <div className="mission-title">
                <span className="task-id">#{t.id}</span> {t.title}
              </div>
              <StageTrack task={t} />
              <StatusBadge status={t.status} running={t.running} />
              {t.running && activity[t.id] && <div className="card-activity">{activity[t.id]}</div>}
            </a>
          ))}

          <h3>
            On duty <span className="count">{busy}</span>
          </h3>
          {!src && <p className="empty">The pixel office isn't running.</p>}
          {src && roster === null && <p className="empty">Waiting for the office…</p>}
          {src && roster !== null && busy === 0 && <p className="empty">Everyone is at rest.</p>}
          <ul className="duty">
            {onDuty.map((a) => (
              <li key={a.id} className={`duty-row duty-${a.state}`} onMouseEnter={() => highlight(a.id)} onMouseLeave={() => highlight(null)}>
                <RoleIcon role={a.name} />
                <div className="duty-text">
                  <div className="duty-name">
                    {a.name}
                    <span className="duty-state">{STATE_LABELS[a.state]}</span>
                  </div>
                  {a.task && <div className="duty-task">{a.task}</div>}
                  {a.activity && <div className="card-activity">{a.activity}</div>}
                </div>
              </li>
            ))}
          </ul>
          {info && !info.linked && info.running && <p className="hint">Start the pixel office with {info.start} so office agents appear in it.</p>}
        </div>
      </aside>

      <section className="office-stage">
        {src ? (
          // ?embed: no toolbars, and the scene scales itself to this frame (see apps/pixel embed.ts).
          <iframe ref={frameRef} className="office-frame" src={src} title="Pixel office" onLoad={() => tell({ type: 'hello' })} />
        ) : (
          <div className="office-off">
            <div className="panel">
              <h1>The pixel office isn't running</h1>
              <p>
                Start it from the repo root with <code>{info?.start ?? 'npm run pixel'}</code>. This page connects within a few seconds.
              </p>
              <p className="hint">Each running agent works at its desk. A waiting bubble means a gate needs you.</p>
            </div>
          </div>
        )}

        {!panel && (
          <div className="hud hud-tl">
            <button onClick={togglePanel} title="Show missions and who is on duty">
              <span className={active.some((t) => t.running) || onDuty.some((a) => a.state === 'working') ? 'pulse' : 'pulse off'} aria-hidden />
              Live
              <span className="count">{active.length + busy}</span>
            </button>
          </div>
        )}
        {needsYou.length > 0 && (
          <div className="hud hud-tr">
            <a className="btn alert-chip" href={`#/task/${needsYou[0]!.id}`}>
              <Icon name="warn" />
              {needsYou.length === 1 ? `#${needsYou[0]!.id} needs you` : `${needsYou.length} missions need you`}
            </a>
          </div>
        )}
        <div className="hud hud-br">
          {src && (
            <button onClick={toggleFit} title={fit === 'contain' ? 'Fill the page; edges may be cropped' : 'Show the whole office'}>
              {fit === 'contain' ? 'Fill' : 'Fit'}
            </button>
          )}
          <button onClick={onToggleImmersive} title={immersive ? 'Leave full screen' : 'Full screen'} aria-label={immersive ? 'Leave full screen' : 'Full screen'}>
            <Icon name={immersive ? 'shrink' : 'expand'} />
          </button>
          <button className="cta" onClick={onAssign}>
            <Icon name="flag" />
            Assign mission
          </button>
        </div>
      </section>
    </div>
  );
}
