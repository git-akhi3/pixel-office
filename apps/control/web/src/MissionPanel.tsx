import { useEffect, useRef, useState } from 'react';
import { api, type Repo, type Task } from './api';
import { Icon, RoleIcon } from './icons';

/** What happens to a mission after launch, so the gates are no surprise. */
const FLOW: Array<{ role: string; label: string; you?: boolean }> = [
  { role: 'manager', label: 'Sizes it' },
  { role: 'architect', label: 'Plans' },
  { role: 'you', label: 'You approve', you: true },
  { role: 'coder', label: 'Builds' },
  { role: 'reviewer', label: 'Reviews' },
  { role: 'tester', label: 'Tests' },
  { role: 'you', label: 'You ship', you: true },
];

/**
 * The "assign mission" side panel: a new task or a PR review, from any page. It slides over the page
 * instead of replacing it, so the office (or the board) stays in view. A half-written brief survives
 * closing the panel.
 */
export function MissionPanel({
  open,
  repos,
  onClose,
  onCreated,
  onError,
}: {
  open: boolean;
  repos: Repo[];
  onClose: () => void;
  onCreated: (task: Task) => void;
  onError: (e: unknown) => void;
}) {
  const [repoId, setRepoId] = useState<number | ''>(repos[0]?.id ?? '');
  const [input, setInput] = useState('');
  const [kind, setKind] = useState<'feature' | 'bug'>('feature');
  const [mode, setMode] = useState<'task' | 'review'>('task');
  const [prUrl, setPrUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const briefRef = useRef<HTMLTextAreaElement>(null);
  const prRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (repoId === '' && repos[0]) setRepoId(repos[0].id);
  }, [repos, repoId]);

  useEffect(() => {
    if (open) (mode === 'review' ? prRef : briefRef).current?.focus();
  }, [open, mode]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const ready = mode === 'review' ? !!prUrl.trim() : repoId !== '' && !!input.trim();
  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    try {
      const task =
        mode === 'review' ? await api.createReview(prUrl.trim()) : await api.createTask({ repoId: repoId as number, input, kind });
      setInput('');
      setPrUrl('');
      onCreated(task);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`drawer-layer${open ? ' open' : ''}`} aria-hidden={!open}>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Assign a mission">
        <header className="drawer-head">
          <Icon name="flag" size={24} />
          <div>
            <h2>New mission</h2>
            <p>Brief the team. They take it from here.</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" tabIndex={open ? 0 : -1}>
            <Icon name="close" />
          </button>
        </header>
        {open &&
          (repos.length === 0 ? (
            <div className="drawer-body">
              <p className="empty">The team needs a repository to work in first.</p>
              <a className="btn primary" href="#/repos" onClick={onClose}>
                Add a repository
              </a>
            </div>
          ) : (
            <form className="drawer-form" onSubmit={submit}>
              <div className="drawer-body">
                <div className="field">
                  <span className="field-label">Mission type</span>
                  <div className="chips" role="radiogroup" aria-label="Mission type">
                    <button type="button" role="radio" aria-checked={mode === 'task'} className={mode === 'task' ? 'chip active' : 'chip'} onClick={() => setMode('task')}>
                      <Icon name="coder" /> Build or fix
                    </button>
                    <button type="button" role="radio" aria-checked={mode === 'review'} className={mode === 'review' ? 'chip active' : 'chip'} onClick={() => setMode('review')}>
                      <Icon name="reviewer" /> Review a PR
                    </button>
                  </div>
                </div>

                {mode === 'review' ? (
                  <>
                    <label className="field">
                      <span className="field-label">Pull request link</span>
                      <input ref={prRef} value={prUrl} onChange={(e) => setPrUrl(e.target.value)} placeholder="https://github.com/owner/repo/pull/123" />
                    </label>
                    <p className="hint">The PR's repo must be registered under Repos. The reviewer drafts comments; you edit them and decide whether to post.</p>
                  </>
                ) : (
                  <>
                    <div className="field">
                      <span className="field-label">Repository</span>
                      {repos.length <= 6 ? (
                        <div className="chips" role="radiogroup" aria-label="Repository">
                          {repos.map((r) => (
                            <button key={r.id} type="button" role="radio" aria-checked={repoId === r.id} className={repoId === r.id ? 'chip active' : 'chip'} onClick={() => setRepoId(r.id)}>
                              <Icon name="repo" /> {r.name}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <select value={repoId} onChange={(e) => setRepoId(Number(e.target.value))} aria-label="Repository">
                          {repos.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                    <div className="field">
                      <span className="field-label">Kind</span>
                      <div className="chips" role="radiogroup" aria-label="Kind">
                        {(['feature', 'bug'] as const).map((k) => (
                          <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'chip active' : 'chip'} onClick={() => setKind(k)}>
                            <Icon name={k === 'feature' ? 'gem' : 'debugger'} /> {k === 'feature' ? 'Feature / change' : 'Bug'}
                          </button>
                        ))}
                      </div>
                    </div>
                    <label className="field">
                      <span className="field-label">Briefing</span>
                      <textarea
                        ref={briefRef}
                        rows={9}
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && void submit()}
                        placeholder="Describe the task as you would to a teammate: what, why, and anything they should know (links, error messages, files)."
                      />
                    </label>
                    <div className="flow" aria-label="What happens next">
                      {FLOW.map((s, i) => (
                        <span key={i} className={`flow-step${s.you ? ' flow-you' : ''}`}>
                          {s.you ? <Icon name="check" /> : <RoleIcon role={s.role} />}
                          <span>{s.label}</span>
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </div>
              <footer className="drawer-foot">
                <button className="primary big" disabled={busy || !ready}>
                  <Icon name="play" />
                  {busy ? 'Launching…' : mode === 'review' ? 'Start the review' : 'Launch mission'}
                </button>
                {mode === 'task' && <span className="hint">or press ⌘ Enter</span>}
              </footer>
            </form>
          ))}
      </aside>
    </div>
  );
}
