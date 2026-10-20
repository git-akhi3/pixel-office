import { useEffect, useState } from 'react';
import { api, type GraphInfo, type Repo, type Settings, type SkillInfo } from './api';
import { Icon } from './icons';
import { Meter, timeAgo } from './ui';

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
  mergeMethod: 'squash',
  ship: {},
  gitAuthor: '',
  allowlist: [],
};

const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** "coder: a, b" lines → { coder: ["a", "b"] }. */
function parseSkillLines(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const line of lines(text)) {
    const [role, rest] = line.split(':');
    if (!role || rest === undefined) continue;
    out[role.trim()] = rest
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return out;
}

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
  const [graph, setGraph] = useState<GraphInfo | null>(null);

  useEffect(() => {
    api
      .ghAccounts()
      .then(setAccounts)
      .catch(() => setAccounts([]));
    api
      .graphify()
      .then(setGraph)
      .catch(() => setGraph(null));
  }, [repos]);

  const buildGraph = async (r: Repo) => {
    try {
      await api.buildGraph(r.id);
      setGraph(await api.graphify());
      // Builds run in the background: refresh until this one is done.
      const poll = window.setInterval(async () => {
        const g = await api.graphify().catch(() => null);
        if (g) setGraph(g);
        if (!g?.repos.find((x) => x.repoId === r.id)?.building) window.clearInterval(poll);
      }, 5000);
    } catch (err) {
      onError(err);
    }
  };

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
        ship: editing.ship?.staging?.deployCmd?.trim() ? editing.ship : {},
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
            className="mono"
            required
            value={editing.path ?? ''}
            onChange={(e) => set('path', e.target.value)}
            placeholder="/Users/you/code/galaxy"
          />
        </label>
        <label>
          Worktree setup command (run by the office in each new worktree; $REPO_PATH is this checkout)
          <input
            className="mono"
            value={editing.setupCmd ?? ''}
            onChange={(e) => set('setupCmd', e.target.value)}
            placeholder={'npm ci   or   ln -s "$REPO_PATH/.venv" .venv'}
          />
        </label>
        <div className="grid3">
          <label>
            Build command
            <input
              className="mono"
              value={editing.buildCmd ?? ''}
              onChange={(e) => set('buildCmd', e.target.value)}
              placeholder="npm run build"
            />
          </label>
          <label>
            Test command
            <input
              className="mono"
              value={editing.testCmd ?? ''}
              onChange={(e) => set('testCmd', e.target.value)}
              placeholder="npm test"
            />
          </label>
          <label>
            Lint command
            <input
              className="mono"
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
          Merge method (when you approve a PR, the office merges it this way)
          <select value={editing.mergeMethod ?? 'squash'} onChange={(e) => set('mergeMethod', e.target.value as Repo['mergeMethod'])}>
            <option value="squash">Squash and merge</option>
            <option value="merge">Merge commit</option>
            <option value="rebase">Rebase and merge</option>
          </select>
        </label>
        <StagingFields value={editing.ship?.staging} onChange={(staging) => set('ship', staging ? { staging } : {})} />
        <label>
          Protected branches (one per line; main, master and the default branch are always protected)
          <textarea
            rows={2}
            value={(editing.protectedBranches ?? []).join('\n')}
            onChange={(e) => set('protectedBranches', lines(e.target.value))}
          />
        </label>
        <label>
          Extra skills for this repo's agents (one line per agent, e.g. "coder: fastify-conventions, our-api-style")
          <textarea
            rows={3}
            value={Object.entries(editing.skills ?? {})
              .map(([role, names]) => `${role}: ${names.join(', ')}`)
              .join('\n')}
            onChange={(e) => set('skills', parseSkillLines(e.target.value))}
            placeholder="coder: fastify-conventions"
          />
        </label>
        <label className="switch">
          <input type="checkbox" checked={!!editing.graphify} onChange={(e) => set('graphify', e.target.checked)} />
          <span>
            <strong>Code graph (Graphify)</strong>
            <span className="hint">
              Gives the architect, reviewer and debugger a code graph of this repo, built locally from code only (no tokens). Turn it off if the
              token stats show no saving.
            </span>
          </span>
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
        <h1>
          <Icon name="repo" size={24} /> Repositories
        </h1>
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
              <div className="hint mono">{r.path}</div>
              <div className="hint">
                test: <span className="mono">{r.testCmd ?? '–'}</span> · lint: <span className="mono">{r.lintCmd ?? '–'}</span> · {r.allowlist.length} approved
                command(s)
              </div>
              {r.graphify && <GraphLine info={graph} repoId={r.id} onBuild={() => buildGraph(r)} />}
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

function GraphLine({ info, repoId, onBuild }: { info: GraphInfo | null; repoId: number; onBuild: () => void }) {
  if (!info) return null;
  if (!info.installed) {
    return (
      <div className="hint">
        Code graph: Graphify isn't installed. Install it with <code>{info.install}</code>
      </div>
    );
  }
  const g = info.repos.find((x) => x.repoId === repoId);
  const stat = (s: { runs: number; avg: number }) => (s.runs ? `${Math.round(s.avg / 1000)}k avg over ${s.runs} runs` : 'no runs yet');
  return (
    <div className="hint">
      Code graph: {g?.building ? 'building…' : g?.builtAt ? `built ${new Date(g.builtAt).toLocaleString()}` : 'not built'}{' '}
      <button className="link" onClick={onBuild} disabled={g?.building}>
        {g?.builtAt ? 'Rebuild' : 'Build now'}
      </button>
      {g && (
        <div>
          Architect/reviewer/debugger tokens with the graph: {stat(g.withGraph)} · without: {stat(g.without)}
        </div>
      )}
    </div>
  );
}

export function SettingsPanel({ onError }: { onError: (e: unknown) => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  useEffect(() => {
    api.settings().then(setS).catch(onError);
    api
      .skills()
      .then((all) => setSkills(all.filter((x) => !x.wrapper)))
      .catch(onError);
  }, [onError]);
  if (!s) return <p className="empty">Loading…</p>;

  const save = async (patch: Partial<Settings>) => {
    try {
      setS(await api.saveSettings(patch));
    } catch (e) {
      onError(e);
    }
  };

  return (
    <div className="panel">
      <h1>
        <Icon name="gear" size={24} /> Settings
      </h1>
      <label className="switch">
        <input type="checkbox" checked={s.autoAllowCommands} onChange={(e) => save({ autoAllowCommands: e.target.checked })} />
        <span>
          <strong>Auto-allow commands</strong>
          <span className="hint">
            Agents run commands off the allow-list without asking. Deploys, publishing, cloud, database and remote
            tools, sending data with curl, and killing programs still ask you. Secrets, git push and writes outside the
            worktree stay blocked either way.
          </span>
        </span>
      </label>
      <label className="switch">
        <input type="checkbox" checked={s.plansWaitForMe} onChange={(e) => save({ plansWaitForMe: e.target.checked })} />
        <span>
          <strong>Plans wait for me</strong>
          <span className="hint">
            Off: the architect's plan goes ahead on its own (it's posted in the thread; ask for a new one if it's off), except after a
            briefing or once you've sent a plan for that task back. On: every plan waits for your OK.
          </span>
        </span>
      </label>
      <label className="switch">
        <input type="checkbox" checked={s.sonnetForSmall} onChange={(e) => save({ sonnetForSmall: e.target.checked })} />
        <span>
          <strong>Sonnet for small tasks</strong>
          <span className="hint">
            On size S tasks, the reviewer runs on Sonnet (medium effort) instead of Opus. Bigger tasks keep its own model,
            and the architect always plans on its own model.
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
      <h2>Briefing</h2>
      <label>
        Skill the architect follows when it grills you
        <select value={s.grillSkill} onChange={(e) => save({ grillSkill: e.target.value })}>
          {!skills.some((x) => x.name === s.grillSkill) && <option value={s.grillSkill}>{s.grillSkill} (not in the catalog: built-in rules)</option>}
          {skills.map((x) => (
            <option key={x.name} value={x.name}>
              {x.name}
            </option>
          ))}
        </select>
        <span className="hint">
          {skills.some((x) => x.name === s.grillSkill)
            ? 'Added to the architect on missions with Grill me on (Auto decides per task in the mission panel).'
            : 'Import "grilling" from Claude Code on the Team page for the full interview method; until then the architect uses short built-in rules.'}
        </span>
      </label>
      <h2>Usage</h2>
      <label>
        Pause new steps at this much of the 5-hour or 7-day limit
        <select value={s.usagePauseAt} onChange={(e) => save({ usagePauseAt: Number(e.target.value) })}>
          {[0.8, 0.85, 0.9, 0.95, 1].map((v) => (
            <option key={v} value={v}>
              {v === 1 ? 'Never pause' : `${Math.round(v * 100)}%`}
            </option>
          ))}
        </select>
        <span className="hint">Running steps always finish. Paused work starts again when the window resets.</span>
      </label>
      {s.rateLimit ? (
        <div className="usage-rows">
          {s.rateLimit.fiveHour !== undefined && <Meter value={s.rateLimit.fiveHour} segments={20} label="5-hour window" />}
          {s.rateLimit.sevenDay !== undefined && <Meter value={s.rateLimit.sevenDay} segments={20} label="7-day window" />}
          <span className="hint">
            {' '}
            (as of {timeAgo(s.rateLimit.at)}
            {s.rateLimit.resetsAt
              ? `, 5-hour window resets ${new Date(s.rateLimit.resetsAt * 1000).toLocaleTimeString()}`
              : ''}
            )
          </span>
        </div>
      ) : (
        <p className="hint">Shown after the first agent run.</p>
      )}
    </div>
  );
}

type Staging = NonNullable<Repo['ship']['staging']>;

/** Staging after the merge: the deploy the office runs with your logins, and what the verifier checks. */
function StagingFields({ value, onChange }: { value: Staging | undefined; onChange: (v: Staging | undefined) => void }) {
  const v: Staging = value ?? { deployCmd: '' };
  // Kept while I edit, even with no deploy command yet; saving drops a section without one.
  const set = (patch: Partial<Staging>) => onChange({ ...v, ...patch });
  return (
    <fieldset className="staging">
      <legend>Staging (after you merge)</legend>
      <label>
        Deploy command (run by the office in a fresh checkout of the merged branch, with your CLI logins; empty: merge only)
        <input value={v.deployCmd} onChange={(e) => set({ deployCmd: e.target.value })} placeholder="npm run deploy:staging" />
      </label>
      <div className="grid2">
        <label>
          Run it in (folder in the repo)
          <input value={v.cwd ?? ''} onChange={(e) => set({ cwd: e.target.value || undefined })} placeholder="point-of-sale/wati-relay" />
        </label>
        <label>
          Cloud project (deploy and check are pinned to it)
          <input value={v.project ?? ''} onChange={(e) => set({ project: e.target.value || undefined })} placeholder="pos-staging-0" />
        </label>
      </div>
      <label>
        Cloud account (optional: which of your gcloud logins to use)
        <input value={v.account ?? ''} onChange={(e) => set({ account: e.target.value || undefined })} placeholder="you@example.com" />
      </label>
      <label className="switch">
        <input type="checkbox" checked={!!v.confirm} onChange={(e) => set({ confirm: e.target.checked || undefined })} />
        <span>
          <strong>Ask before deploying</strong>
          <span className="hint">For a staging that serves real users: merging waits for a second tap, "Deploy now".</span>
        </span>
      </label>
      <label>
        URLs the verifier may GET (one per line)
        <textarea rows={2} value={(v.healthUrls ?? []).join('\n')} onChange={(e) => set({ healthUrls: lines(e.target.value) })} />
      </label>
      <label>
        Notes for the verifier (log queries, what must hold, what it must never do)
        <textarea rows={3} value={v.checkNotes ?? ''} onChange={(e) => set({ checkNotes: e.target.value || undefined })} />
      </label>
      <label>
        Rollback command (offered as a button when the check fails)
        <input value={v.rollbackCmd ?? ''} onChange={(e) => set({ rollbackCmd: e.target.value || undefined })} />
      </label>
    </fieldset>
  );
}
