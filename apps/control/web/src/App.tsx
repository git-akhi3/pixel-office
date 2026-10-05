import { useCallback, useEffect, useState } from 'react';
import { api, connectLive, type OfficeEvent, type Repo, type Task } from './api';
import { Board } from './Board';
import { NewTask, Repos, SettingsPanel } from './Forms';
import { TaskView } from './TaskView';

function useHash(): string {
  const [hash, setHash] = useState(location.hash || '#/');
  useEffect(() => {
    const on = () => setHash(location.hash || '#/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export function App() {
  const hash = useHash();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<OfficeEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onError = useCallback((e: unknown) => setError(e instanceof Error ? e.message : String(e)), []);
  const loadRepos = useCallback(() => api.repos().then(setRepos).catch(onError), [onError]);

  useEffect(() => {
    api.tasks().then(setTasks).catch(onError);
    void loadRepos();
    return connectLive(
      (m) => {
        if (m.type === 'task') setTasks((prev) => [m.task, ...prev.filter((t) => t.id !== m.task.id)].sort((a, b) => b.updatedAt - a.updatedAt));
        else setLastEvent(m.event);
      },
      (up) => {
        setConnected(up);
        if (up) api.tasks().then(setTasks).catch(onError);
      },
    );
  }, [loadRepos, onError]);

  const waiting = tasks.filter((t) => t.column === 'Awaiting you' || t.pendingGates.length > 0).length;
  useEffect(() => {
    document.title = waiting ? `(${waiting}) Pixel Office` : 'Pixel Office';
  }, [waiting]);

  const repoName = (id: number) => repos.find((r) => r.id === id)?.name ?? `repo ${id}`;
  const taskMatch = hash.match(/^#\/task\/(\d+)/);

  return (
    <>
      <header className="topbar">
        <a href="#/" className="brand">
          <span className="logo" aria-hidden />
          Pixel Office
        </a>
        <nav>
          <a href="#/" className={hash === '#/' ? 'active' : ''}>
            Board{waiting ? <span className="dot">{waiting}</span> : null}
          </a>
          <a href="#/repos" className={hash === '#/repos' ? 'active' : ''}>
            Repos
          </a>
          <a href="#/settings" className={hash === '#/settings' ? 'active' : ''}>
            Settings
          </a>
          <a href="#/new" className="new-task">
            + New task
          </a>
        </nav>
        <span className={`live ${connected ? 'on' : 'off'}`} title={connected ? 'Live' : 'Reconnecting…'} />
      </header>
      {error && (
        <div className="error" role="alert">
          {error}
          <button onClick={() => setError(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      <main>
        {taskMatch ? (
          <TaskView id={Number(taskMatch[1])} lastEvent={lastEvent} onError={onError} />
        ) : hash === '#/new' ? (
          <NewTask repos={repos} onError={onError} />
        ) : hash === '#/repos' ? (
          <Repos repos={repos} reload={loadRepos} onError={onError} />
        ) : hash === '#/settings' ? (
          <SettingsPanel onError={onError} />
        ) : (
          <Board tasks={tasks} repoName={repoName} />
        )}
      </main>
    </>
  );
}
