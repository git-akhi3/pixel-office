import { useCallback, useEffect, useRef, useState } from 'react';
import { api, connectLive, type OfficeEvent, type Repo, type Settings, type Task } from './api';
import { Board } from './Board';
import { Repos, SettingsPanel } from './Forms';
import { Icon, type IconName } from './icons';
import { KnowledgePage } from './Knowledge';
import { MissionPanel } from './MissionPanel';
import { Office } from './Office';
import { TaskView } from './TaskView';
import { Team } from './Team';
import { Meter } from './ui';

function useHash(): string {
  const [hash, setHash] = useState(location.hash || '#/');
  useEffect(() => {
    const on = () => setHash(location.hash || '#/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

interface Toast {
  id: number;
  tone: 'error' | 'ok';
  text: string;
  href?: string;
}

const NAV: Array<{ href: string; label: string; icon: IconName }> = [
  { href: '#/', label: 'Board', icon: 'board' },
  { href: '#/office', label: 'Office', icon: 'office' },
  { href: '#/repos', label: 'Repos', icon: 'repo' },
  { href: '#/team', label: 'Team', icon: 'team' },
  { href: '#/knowledge', label: 'Knowledge', icon: 'book' },
  { href: '#/settings', label: 'Settings', icon: 'gear' },
];

export function App() {
  const hash = useHash();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<OfficeEvent | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [proposalCount, setProposalCount] = useState(0);
  const [missionOpen, setMissionOpen] = useState(false);
  // What each running task's agent did last ("Bash npm test"), for the live lists.
  const [activity, setActivity] = useState<Record<number, string>>({});
  // Immersive: the office alone, without the top bar. Real fullscreen where the browser allows it.
  const [immersive, setImmersive] = useState(false);
  const openMission = useCallback(() => setMissionOpen(true), []);
  const closeMission = useCallback(() => setMissionOpen(false), []);

  const toastId = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);
  const toast = useCallback(
    (t: Omit<Toast, 'id'>) => {
      const id = ++toastId.current;
      setToasts((prev) => [...prev.slice(-3), { ...t, id }]);
      window.setTimeout(() => dismiss(id), t.tone === 'error' ? 15_000 : 7_000);
    },
    [dismiss],
  );
  const onError = useCallback((e: unknown) => toast({ tone: 'error', text: e instanceof Error ? e.message : String(e) }), [toast]);
  const loadRepos = useCallback(() => api.repos().then(setRepos).catch(onError), [onError]);

  const loadStatus = useCallback(() => {
    api.settings().then(setSettings).catch(() => {});
    api.proposals().then((p) => setProposalCount(p.length)).catch(() => {});
  }, []);
  useEffect(() => {
    loadStatus();
    const t = window.setInterval(loadStatus, 60_000);
    return () => window.clearInterval(t);
  }, [loadStatus]);

  useEffect(() => {
    api.tasks().then(setTasks).catch(onError);
    void loadRepos();
    return connectLive(
      (m) => {
        if (m.type === 'task') setTasks((prev) => [m.task, ...prev.filter((t) => t.id !== m.task.id)].sort((a, b) => b.updatedAt - a.updatedAt));
        else {
          const e = m.event;
          setLastEvent(e);
          if (e.type === 'alert' || e.type === 'step_start') loadStatus();
          if (e.taskId !== null) {
            const id = e.taskId;
            if (e.type === 'tool') setActivity((prev) => ({ ...prev, [id]: `${String(e.payload.tool)} ${String(e.payload.input ?? '')}`.trim() }));
            else if (e.type === 'step_start') setActivity((prev) => ({ ...prev, [id]: `${String(e.payload.role)} started` }));
            else if (e.type === 'step_end') setActivity(({ [id]: _, ...rest }) => rest);
          }
        }
      },
      (up) => {
        setConnected(up);
        if (up) api.tasks().then(setTasks).catch(onError);
      },
    );
  }, [loadRepos, onError, loadStatus]);

  const waiting = tasks.filter((t) => t.column === 'Awaiting you' || t.pendingGates.length > 0).length;
  useEffect(() => {
    document.title = waiting ? `(${waiting}) Pixel Office` : 'Pixel Office';
  }, [waiting]);

  // "#/new" (old links, bookmarks) opens the mission panel over the board.
  useEffect(() => {
    if (hash !== '#/new') return;
    setMissionOpen(true);
    location.replace('#/');
  }, [hash]);

  const onOffice = hash === '#/office';
  const toggleImmersive = useCallback(() => {
    if (document.fullscreenElement) return void document.exitFullscreen();
    if (immersive) return setImmersive(false);
    // Some embedded browsers refuse fullscreen: hiding the top bar is the fallback.
    const request = document.documentElement.requestFullscreen?.();
    if (request) request.catch(() => setImmersive(true));
    else setImmersive(true);
  }, [immersive]);
  useEffect(() => {
    const on = () => setImmersive(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  useEffect(() => {
    // Fullscreen belongs to the office: leaving it for another page brings the top bar back.
    if (onOffice) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    setImmersive(false);
  }, [onOffice]);
  useEffect(() => {
    if (!immersive || document.fullscreenElement) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !missionOpen && setImmersive(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [immersive, missionOpen]);

  const repoName = (id: number) => repos.find((r) => r.id === id)?.name ?? `repo ${id}`;
  const taskMatch = hash.match(/^#\/task\/(\d+)/);
  const usage = settings?.rateLimit;
  const isActive = (href: string) => (href === '#/' ? hash === '#/' || !!taskMatch : hash === href);

  return (
    <div className={`app${immersive && onOffice ? ' immersive' : ''}`}>
      <header className="topbar">
        <a href="#/" className="brand">
          <span className="logo" aria-hidden />
          <span className="brand-name">Pixel Office</span>
        </a>
        <nav>
          {NAV.map((n) => (
            <a key={n.href} href={n.href} className={isActive(n.href) ? 'active' : ''} aria-label={n.label} title={n.label}>
              <Icon name={n.icon} />
              <span className="nav-label">{n.label}</span>
              {n.href === '#/' && waiting > 0 && <span className="dot">{waiting}</span>}
              {n.href === '#/knowledge' && proposalCount > 0 && <span className="dot">{proposalCount}</span>}
            </a>
          ))}
        </nav>
        <div className="topbar-right">
          {usage && (usage.fiveHour !== undefined || usage.sevenDay !== undefined) && (
            <a href="#/settings" className="usage" title="Subscription usage. Click for settings.">
              {usage.fiveHour !== undefined && <Meter value={usage.fiveHour} segments={8} label="5H" title={`5-hour usage: ${Math.round(usage.fiveHour * 100)}%`} />}
              {usage.sevenDay !== undefined && <Meter value={usage.sevenDay} segments={8} label="7D" title={`7-day usage: ${Math.round(usage.sevenDay * 100)}%`} />}
            </a>
          )}
          <span className={`live ${connected ? 'on' : 'off'}`} title={connected ? 'Connected to the office' : 'Reconnecting…'}>
            <span className="live-dot" aria-hidden />
            {connected ? 'Live' : 'Offline'}
          </span>
          {!onOffice && (
            <button className="cta" onClick={openMission} aria-label="Assign mission">
              <Icon name="flag" />
              <span className="cta-label">Assign mission</span>
            </button>
          )}
        </div>
      </header>
      {settings?.usage?.paused && (
        <div className="banner" role="status">
          <Icon name="bolt" />
          <span>
            Usage is at {Math.round(((settings.usage.window === '7-day' ? settings.rateLimit?.sevenDay : settings.rateLimit?.fiveHour) ?? 0) * 100)}% of the{' '}
            {settings.usage.window} limit: no new agent steps start until {new Date(settings.usage.until!).toLocaleString()}. Running steps finish.{' '}
            <a href="#/settings">Change the threshold</a>
          </span>
        </div>
      )}
      <main className={onOffice ? 'flush' : ''}>
        {taskMatch ? (
          <TaskView id={Number(taskMatch[1])} lastEvent={lastEvent} onError={onError} />
        ) : hash === '#/repos' ? (
          <Repos repos={repos} reload={loadRepos} onError={onError} />
        ) : onOffice ? (
          <Office
            tasks={tasks}
            activity={activity}
            immersive={immersive}
            onToggleImmersive={toggleImmersive}
            onAssign={openMission}
            onError={onError}
          />
        ) : hash === '#/team' ? (
          <Team onError={onError} />
        ) : hash === '#/knowledge' ? (
          <KnowledgePage repos={repos} onError={onError} onChanged={loadStatus} />
        ) : hash === '#/settings' ? (
          <SettingsPanel onError={onError} />
        ) : (
          <Board tasks={tasks} repoName={repoName} activity={activity} onAssign={openMission} />
        )}
      </main>
      <MissionPanel
        open={missionOpen}
        repos={repos}
        onClose={closeMission}
        onCreated={(task) => {
          setMissionOpen(false);
          toast({ tone: 'ok', text: `Mission #${task.id} is with the team.`, href: `#/task/${task.id}` });
        }}
        onError={onError}
      />
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <Icon name={t.tone === 'error' ? 'warn' : 'check'} />
            <span className="toast-text">{t.text}</span>
            {t.href && (
              <a href={t.href} onClick={() => dismiss(t.id)}>
                Open
              </a>
            )}
            <button className="icon-btn" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              <Icon name="close" size={8} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
