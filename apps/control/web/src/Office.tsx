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
  /** The role: a resident's sub-agent type, a teammate's name, or the session folder. */
  name: string;
  /** The theme's display name for a resident ("Fury"), when it has one. */
  label?: string;
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
 * The Avengers theme (tools/avengers-pack, applied with tools/apply.sh helicarrier): the office reports
 * `theme: "avengers"` with its roster, and the page then speaks S.H.I.E.L.D. The wording lives here; the
 * hero portraits are built by tools/avengers/build_pack.py into public/heroes/.
 */
const AVENGERS = 'avengers';
const COPY = {
  classic: {
    live: 'Live',
    missions: 'Missions',
    nothing: 'Nothing in flight.',
    assign: 'Assign a mission',
    onDuty: 'On duty',
    atRest: 'Everyone is at rest.',
    assemble: 'Assign mission',
    needsYou: (id: number) => `#${id} needs you`,
    needYou: (n: number) => `${n} missions need you`,
    asks: 'The architect asks you',
  },
  avengers: {
    live: 'Briefing',
    missions: 'Missions',
    nothing: 'Quiet skies, Director.',
    assign: 'Assemble the team',
    onDuty: 'Assembled',
    atRest: 'The team is standing by.',
    assemble: 'Assemble',
    needsYou: (id: number) => `Director, #${id} needs your call`,
    needYou: (n: number) => `Director, ${n} missions need your call`,
    asks: 'Strange asks you',
  },
};

/** A crew member's face: the theme's pixel portrait when it has one, else the role emblem. */
function Face({ entry, themed }: { entry: RosterEntry; themed: boolean }) {
  if (!themed) return <RoleIcon role={entry.name} />;
  const file = entry.kind === 'resident' ? entry.name : 'agent';
  return <img className="portrait" src={`/heroes/${file}.png`} alt="" width={32} height={32} />;
}

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
  // The theme pack the office is running (its layout's `theme`), reported with every roster.
  const [theme, setTheme] = useState<string | null>(null);
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
      const data = e.data as { source?: string; type?: string; agents?: RosterEntry[]; theme?: unknown } | null;
      if (data?.source !== 'pixel-agents-embed' || data.type !== 'roster' || !Array.isArray(data.agents)) return;
      setRoster(data.agents.filter((a) => typeof a?.id === 'number' && typeof a.name === 'string'));
      setTheme(typeof data.theme === 'string' ? data.theme : null);
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
  const themed = theme === AVENGERS;
  const copy = themed ? COPY.avengers : COPY.classic;

  return (
    <div className={`office-page${panel ? ' panel-open' : ''}${themed ? ' theme-avengers' : ''}`}>
      <aside className="live-panel" aria-hidden={!panel}>
        <header className="live-head">
          <span className="live-title">
            <span className="pulse" aria-hidden /> {copy.live}
          </span>
          <button className="icon-btn" onClick={togglePanel} aria-label="Hide the live panel" title="Hide" tabIndex={panel ? 0 : -1}>
            <Icon name="left" />
          </button>
        </header>
        <div className="live-scroll">
          <h3>
            {copy.missions} <span className="count">{active.length}</span>
          </h3>
          {active.length === 0 && (
            <p className="empty">
              {copy.nothing}{' '}
              <button className="link" onClick={onAssign}>
                {copy.assign}
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
              {t.pendingGates.some((g) => g.kind === 'question') && (
                <div className="card-alert">
                  <Icon name="question" size={8} /> {copy.asks}
                </div>
              )}
              {t.running && activity[t.id] && <div className="card-activity">{activity[t.id]}</div>}
            </a>
          ))}

          <h3>
            {copy.onDuty} <span className="count">{busy}</span>
          </h3>
          {!src && <p className="empty">The pixel office isn't running.</p>}
          {src && roster === null && <p className="empty">Waiting for the office…</p>}
          {src && roster !== null && busy === 0 && <p className="empty">{copy.atRest}</p>}
          <ul className="duty">
            {onDuty.map((a) => (
              <li key={a.id} className={`duty-row duty-${a.state}`} onMouseEnter={() => highlight(a.id)} onMouseLeave={() => highlight(null)}>
                <Face entry={a} themed={themed} />
                <div className="duty-text">
                  <div className="duty-name">
                    <span className="duty-who">{a.label ?? a.name}</span>
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
              {copy.live}
              <span className="count">{active.length + busy}</span>
            </button>
          </div>
        )}
        {needsYou.length > 0 && (
          <div className="hud hud-tr">
            <a className="btn alert-chip" href={`#/task/${needsYou[0]!.id}`}>
              <Icon name="warn" />
              {needsYou.length === 1 ? copy.needsYou(needsYou[0]!.id) : copy.needYou(needsYou.length)}
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
            {copy.assemble}
          </button>
        </div>
      </section>
    </div>
  );
}
