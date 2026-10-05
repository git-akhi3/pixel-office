import { useEffect, useState } from 'react';
import { api, type Repo, type Settings } from './api';
import { timeAgo } from './ui';

export function NewTask({ repos, onError }: { repos: Repo[]; onError: (e: unknown) => void }) {
  const [repoId, setRepoId] = useState<number | ''>(repos[0]?.id ?? '');
  const [input, setInput] = useState('');
  const [kind, setKind] = useState<'feature' | 'bug'>('feature');
  const [mode, setMode] = useState<'task' | 'review'>('task');
  const [prUrl, setPrUrl] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (repoId === '' && repos[0]) setRepoId(repos[0].id);
  }, [repos, repoId]);

  if (!repos.length) {
    return (
      <div className="panel">
        <h1>New task</h1>
        <p>
          Add a repository first. <a href="#/repos">Go to repositories →</a>
        </p>
      </div>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === 'review' ? !prUrl.trim() : repoId === '' || !input.trim()) return;
    setBusy(true);
    try {
      const task =
        mode === 'review'
          ? await api.createReview(prUrl.trim())
          : await api.createTask({ repoId: repoId as number, input, kind });
      location.hash = `#/task/${task.id}`;
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel" onSubmit={submit}>
      <h1>New task</h1>
      <fieldset className="segmented">
        <legend>What kind of work?</legend>
        <label className={mode === 'task' ? 'active' : ''}>
          <input type="radio" name="mode" checked={mode === 'task'} onChange={() => setMode('task')} />
          Build or fix something
        </label>
        <label className={mode === 'review' ? 'active' : ''}>
          <input type="radio" name="mode" checked={mode === 'review'} onChange={() => setMode('review')} />
          Review a PR
        </label>
      </fieldset>
      {mode === 'review' ? (
        <>
          <label>
            Pull request link
            <input
              value={prUrl}
              onChange={(e) => setPrUrl(e.target.value)}
              placeholder="https://github.com/owner/repo/pull/123"
            />
          </label>
          <p className="hint">
            The PR's repo must be registered under Repos. The reviewer drafts comments; you edit them and
            decide whether to post.
          </p>
          <button className="primary" disabled={busy || !prUrl.trim()}>
            {busy ? 'Creating…' : 'Review it'}
          </button>
        </>
      ) : (
        <>
          <label>
            Repository
            <select value={repoId} onChange={(e) => setRepoId(Number(e.target.value))}>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="segmented">
            <legend>Kind</legend>
            {(['feature', 'bug'] as const).map((k) => (
              <label key={k} className={kind === k ? 'active' : ''}>
                <input type="radio" name="kind" checked={kind === k} onChange={() => setKind(k)} />
                {k === 'feature' ? 'Feature / change' : 'Bug'}
              </label>
            ))}
          </fieldset>
          <label>
            What should be done?
            <textarea
              rows={8}
              required
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Describe the task as you would to a teammate: what, why, and anything they should know (links, error messages, files)."
            />
          </label>
          <p className="hint">
            The manager sizes it, the architect writes a plan, and you approve the plan before any code is
            written.
          </p>
          <button className="primary" disabled={busy || !input.trim()}>
            {busy ? 'Creating…' : 'Hand it to the team'}
          </button>
        </>
      )}
    </form>
  );
}

const EMPTY: Partial<Repo> = {
  name: '',
  path: '',
  defaultBranch: 'main',
  protectedBranches: [],
  setupCmd: '',
  buildCmd: '',
  testCmd: '',
  lintCmd: '',
  ghAccount: '',
  gitAuthor: '',
  allowlist: [],
};

const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

export function Repos({
  repos,
  reload,
  onError,
}: {
  repos: Repo[];
  reload: () => void;
  onError: (e: unknown) => void;
}) {
  const [editing, setEditing] = useState<Partial<Repo> | null>(null);
  const [accounts, setAccounts] = useState<string[]>([]);

  useEffect(() => {
    api
      .ghAccounts()
      .then(setAccounts)
      .catch(() => setAccounts([]));
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    try {
      const body = {
        ...editing,
        setupCmd: editing.setupCmd || null,
        buildCmd: editing.buildCmd || null,
        testCmd: editing.testCmd || null,
        lintCmd: editing.lintCmd || null,
        ghAccount: editing.ghAccount || null,
        gitAuthor: editing.gitAuthor || null,
      };
      delete (body as Partial<Repo>).effectiveAllowlist;
      await api.saveRepo(body, editing.id);
      setEditing(null);
      reload();
    } catch (err) {
      onError(err);
    }
  };

  const remove = async (r: Repo) => {
    if (!confirm(`Remove ${r.name} from the office? (The repository itself is not touched.)`)) return;
    try {
      await api.deleteRepo(r.id);
      reload();
    } catch (err) {
      onError(err);
    }
  };

  if (editing) {
    const set = (k: keyof Repo, v: unknown) => setEditing({ ...editing, [k]: v });
    return (
      <form className="panel" onSubmit={save}>
        <h1>{editing.id ? `Edit ${editing.name}` : 'Add repository'}</h1>
        <div className="grid2">
          <label>
            Name
            <input
              required
              value={editing.name ?? ''}
              onChange={(e) => set('name', e.target.value)}
              placeholder="galaxy"
            />
          </label>
          <label>
            Default branch
            <input
              required
              value={editing.defaultBranch ?? ''}
              onChange={(e) => set('defaultBranch', e.target.value)}
            />
          </label>
        </div>
        <label>
          Local path (repository root)
          <input
            required
            value={editing.path ?? ''}
            onChange={(e) => set('path', e.target.value)}
            placeholder="/Users/you/code/galaxy"
          />
        </label>
        <label>
          Worktree setup command (run by the office in each new worktree; $REPO_PATH is this checkout)
          <input
            value={editing.setupCmd ?? ''}
            onChange={(e) => set('setupCmd', e.target.value)}
            placeholder={'npm ci   or   ln -s "$REPO_PATH/.venv" .venv'}
          />
        </label>
        <div className="grid3">
          <label>
            Build command
            <input
              value={editing.buildCmd ?? ''}
              onChange={(e) => set('buildCmd', e.target.value)}
              placeholder="npm run build"
            />
          </label>
          <label>
            Test command
            <input
              value={editing.testCmd ?? ''}
              onChange={(e) => set('testCmd', e.target.value)}
              placeholder="npm test"
            />
          </label>
          <label>
            Lint command
            <input
              value={editing.lintCmd ?? ''}
              onChange={(e) => set('lintCmd', e.target.value)}
              placeholder="npm run lint"
            />
          </label>
        </div>
        <div className="grid2">
          <label>
            GitHub account (pushes and PRs)
            <select value={editing.ghAccount ?? ''} onChange={(e) => set('ghAccount', e.target.value)}>
              <option value="">gh's active account</option>
              {accounts.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </label>
          <label>
            Git author, if the repo has none
            <input
              value={editing.gitAuthor ?? ''}
              onChange={(e) => set('gitAuthor', e.target.value)}
              placeholder="Your Name <you@example.com>"
            />
          </label>
        </div>
        <label>
          Protected branches (one per line; main, master and the default branch are always protected)
          <textarea
            rows={2}
            value={(editing.protectedBranches ?? []).join('\n')}
            onChange={(e) => set('protectedBranches', lines(e.target.value))}
          />
        </label>
        <label>
          Extra allowed commands (one per line; end with " *" to allow any arguments)
          <textarea
            rows={4}
            value={(editing.allowlist ?? []).join('\n')}
            onChange={(e) => set('allowlist', lines(e.target.value))}
            placeholder={'npx tsc --noEmit\nnpm run *'}
          />
        </label>
        <div className="gate-buttons">
          <button className="primary">Save</button>
          <button type="button" onClick={() => setEditing(null)}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h1>Repositories</h1>
        <button className="primary" onClick={() => setEditing({ ...EMPTY })}>
          Add repository
        </button>
      </div>
      {repos.length === 0 && <p className="empty">No repositories yet.</p>}
      <ul className="repo-list">
        {repos.map((r) => (
          <li key={r.id}>
            <div>
              <strong>{r.name}</strong> <code>{r.defaultBranch}</code>
              {r.ghAccount && <span className="repo-chip">{r.ghAccount}</span>}
              <div className="hint">{r.path}</div>
              <div className="hint">
                test: {r.testCmd ?? '–'} · lint: {r.lintCmd ?? '–'} · {r.allowlist.length} approved command(s)
              </div>
            </div>
            <div className="row-buttons">
              <button onClick={() => setEditing(r)}>Edit</button>
              <button className="danger" onClick={() => remove(r)}>
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SettingsPanel({ onError }: { onError: (e: unknown) => void }) {
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => {
    api.settings().then(setS).catch(onError);
  }, [onError]);
  if (!s) return <p className="empty">Loading…</p>;

  const save = async (patch: Partial<Settings>) => {
    try {
      setS(await api.saveSettings(patch));
    } catch (e) {
      onError(e);
    }
  };
  const pct = (n?: number) => (n === undefined ? '–' : `${Math.round(n * 100)}%`);

  return (
    <div className="panel">
      <h1>Settings</h1>
      <label className="switch">
        <input
          type="checkbox"
          checked={s.autoApprovePush}
          onChange={(e) => save({ autoApprovePush: e.target.checked })}
        />
        <span>
          <strong>Auto-approve push and draft PR</strong>
          <span className="hint">
            Only when review and tests both pass. Never pushes protected branches; PRs always open as drafts.
            Plans always wait for you.
          </span>
        </span>
      </label>
      <label>
        Tasks running at once
        <select value={s.concurrency} onChange={(e) => save({ concurrency: Number(e.target.value) })}>
          {[1, 2, 3, 4].map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
        <span className="hint">Tasks waiting for you don't count. 2 is comfortable on Max 5x.</span>
      </label>
      <h2>PR reviews</h2>
      <label className="switch">
        <input
          type="checkbox"
          checked={s.reviewAutoPickup}
          onChange={(e) => save({ reviewAutoPickup: e.target.checked })}
        />
        <span>
          <strong>Pick up review requests automatically</strong>
          <span className="hint">
            Every 10 minutes, PRs that request your review (in registered repos, per GitHub account) get a
            draft review. Nothing is posted without you.
          </span>
        </span>
      </label>
      <label>
        Skip PRs smaller than (changed lines)
        <input
          type="number"
          min={0}
          value={s.reviewMinLines}
          onChange={(e) => save({ reviewMinLines: Math.max(0, Number(e.target.value) || 0) })}
        />
      </label>
      <button
        onClick={async () => {
          try {
            const r = await api.pickupReviews();
            alert(r.created ? `Queued ${r.created} review(s).` : 'No new review requests.');
          } catch (err) {
            onError(err);
          }
        }}
      >
        Check for review requests now
      </button>
      <h2>Usage</h2>
      {s.rateLimit ? (
        <p>
          5-hour window: <strong>{pct(s.rateLimit.fiveHour)}</strong> · 7-day:{' '}
          <strong>{pct(s.rateLimit.sevenDay)}</strong>
          <span className="hint">
            {' '}
            (as of {timeAgo(s.rateLimit.at)}
            {s.rateLimit.resetsAt
              ? `, 5-hour window resets ${new Date(s.rateLimit.resetsAt * 1000).toLocaleTimeString()}`
              : ''}
            )
          </span>
        </p>
      ) : (
        <p className="hint">Shown after the first agent run.</p>
      )}
    </div>
  );
}
