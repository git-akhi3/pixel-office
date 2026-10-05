import { useCallback, useEffect, useState } from 'react';
import { api, type Proposal, type Repo } from './api';
import { timeAgo } from './ui';

/** Repo knowledge files: notes every agent reads. Retrospectives propose notes; I decide. */
export function KnowledgePage({ repos, onError, onChanged }: { repos: Repo[]; onError: (e: unknown) => void; onChanged: () => void }) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [repoId, setRepoId] = useState<number | null>(repos[0]?.id ?? null);
  const [text, setText] = useState('');
  const [maxLines, setMaxLines] = useState(120);
  const [saved, setSaved] = useState('');

  const loadProposals = useCallback(() => api.proposals().then(setProposals).catch(onError), [onError]);
  useEffect(() => void loadProposals(), [loadProposals]);
  useEffect(() => {
    if (repoId === null && repos[0]) setRepoId(repos[0].id);
  }, [repos, repoId]);
  useEffect(() => {
    if (repoId === null) return;
    api
      .knowledge(repoId)
      .then((k) => {
        setText(k.text);
        setSaved(k.text);
        setMaxLines(k.maxLines);
      })
      .catch(onError);
  }, [repoId, onError, proposals.length]);

  const decide = async (p: Proposal, decision: 'accept' | 'reject', edited?: string) => {
    try {
      await api.decideProposal(p.id, decision, edited);
      await loadProposals();
      onChanged();
    } catch (e) {
      onError(e);
    }
  };

  const lines = text.trimEnd() ? text.trimEnd().split('\n').length : 0;
  const repoName = (id: number) => repos.find((r) => r.id === id)?.name ?? `repo ${id}`;

  return (
    <div className="panel panel-wide">
      <h1>Knowledge</h1>
      <p className="hint">
        Short notes about each repo that every agent reads at the start of every step: conventions, gotchas, lessons from past tasks. They
        live in the office, not in the repo.
      </p>

      <h2>Suggested by retrospectives {proposals.length > 0 && <span className="dot">{proposals.length}</span>}</h2>
      {proposals.length === 0 && <p className="empty">Nothing waiting.</p>}
      <ul className="comments">
        {proposals.map((p) => (
          <ProposalRow key={p.id} p={p} repo={repoName(p.repoId)} onDecide={decide} />
        ))}
      </ul>

      <h2>Notes per repo</h2>
      {repos.length === 0 ? (
        <p className="empty">Add a repo first.</p>
      ) : (
        <>
          <select value={repoId ?? ''} onChange={(e) => setRepoId(Number(e.target.value))}>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <textarea className="code-editor" rows={14} value={text} onChange={(e) => setText(e.target.value)} placeholder="# Repo notes&#10;&#10;- …" />
          <div className="gate-buttons">
            <button
              className="primary"
              disabled={text === saved || lines > maxLines}
              onClick={async () => {
                try {
                  await api.saveKnowledge(repoId!, text);
                  setSaved(text);
                } catch (e) {
                  onError(e);
                }
              }}
            >
              Save
            </button>
            <span className={`hint ${lines > maxLines ? 'over' : ''}`}>
              {lines} / {maxLines} lines
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function ProposalRow({ p, repo, onDecide }: { p: Proposal; repo: string; onDecide: (p: Proposal, d: 'accept' | 'reject', edited?: string) => void }) {
  const [text, setText] = useState(p.text);
  return (
    <li className="comment">
      <div className="comment-head">
        <span className="repo-chip">{repo}</span>
        {p.taskId && <a href={`#/task/${p.taskId}`}>task #{p.taskId}</a>}
        <span className="hint">{timeAgo(p.createdAt)}</span>
      </div>
      <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row-buttons">
        <button className="primary" disabled={!text.trim()} onClick={() => onDecide(p, 'accept', text !== p.text ? text : undefined)}>
          Add to notes
        </button>
        <button onClick={() => onDecide(p, 'reject')}>Dismiss</button>
      </div>
    </li>
  );
}
