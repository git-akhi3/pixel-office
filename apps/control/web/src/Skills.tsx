import { useEffect, useMemo, useState } from 'react';
import { api, PICKABLE_ROLES, type AgentInfo, type ImportableSkill, type Role, type SkillInfo, type Task } from './api';
import { Icon, RoleIcon } from './icons';
import { roleOf } from './ui';

/** Skills an agent can be given: the catalog without wrappers (they only call other skills). */
export function useCatalog(onError: (e: unknown) => void, reloadKey: unknown = null): SkillInfo[] | null {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  useEffect(() => {
    api
      .skills()
      .then((all) => setSkills(all.filter((s) => !s.wrapper)))
      .catch(onError);
  }, [onError, reloadKey]);
  return skills;
}

/** A role's skills as removable chips, plus a picker for the rest of the catalog. */
export function SkillChips({
  value,
  catalog,
  onChange,
  disabled,
  label,
}: {
  value: string[];
  catalog: SkillInfo[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  label: string;
}) {
  const rest = catalog.filter((s) => !value.includes(s.name));
  return (
    <div className="skill-chips">
      {value.map((name) => (
        <span key={name} className="skill-chip" title={catalog.find((s) => s.name === name)?.description}>
          {name}
          {!disabled && (
            <button type="button" className="icon-btn" onClick={() => onChange(value.filter((n) => n !== name))} aria-label={`Remove ${name} from the ${label}`}>
              <Icon name="close" size={8} />
            </button>
          )}
        </span>
      ))}
      {!disabled && rest.length > 0 && (
        <select
          className="skill-add"
          value=""
          aria-label={`Add a skill to the ${label}`}
          onChange={(e) => e.target.value && onChange([...value, e.target.value])}
        >
          <option value="">+ skill</option>
          {rest.map((s) => (
            <option key={s.name} value={s.name} title={s.description}>
              {s.name}
            </option>
          ))}
        </select>
      )}
      {disabled && value.length === 0 && <span className="hint">none</span>}
    </div>
  );
}

/** The mission panel's skill picker: what I lock per role. Empty roles are left to the manager. */
export function MissionSkills({
  value,
  onChange,
  catalog,
}: {
  value: Partial<Record<Role, string[]>>;
  onChange: (next: Partial<Record<Role, string[]>>) => void;
  catalog: SkillInfo[] | null;
}) {
  const [open, setOpen] = useState(false);
  const picked = PICKABLE_ROLES.filter((r) => value[r]?.length);
  return (
    <div className="field mission-skills">
      <button type="button" className="disclosure" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'down' : 'right'} size={8} />
        <span className="field-label">Crew skills</span>
        <span className="hint">{picked.length ? `you picked for ${picked.join(', ')}; the manager picks the rest` : 'the manager picks; open to choose yourself'}</span>
      </button>
      {open &&
        (catalog === null ? (
          <p className="empty">Loading the catalog…</p>
        ) : catalog.length === 0 ? (
          <p className="empty">
            The catalog is empty. Add or import skills on the <a href="#/team">Team</a> page.
          </p>
        ) : (
          <div className="role-skills">
            {PICKABLE_ROLES.map((role) => (
              <div key={role} className="role-skill-row">
                <span className="role-skill-name">
                  <RoleIcon role={role} /> {role}
                </span>
                <SkillChips
                  label={role}
                  value={value[role] ?? []}
                  catalog={catalog}
                  onChange={(next) => {
                    const copy = { ...value };
                    if (next.length) copy[role] = next;
                    else delete copy[role];
                    onChange(copy);
                  }}
                />
              </div>
            ))}
            <p className="hint">A role you pick for is locked: the manager won't change it.</p>
          </div>
        ))}
    </div>
  );
}

/** The task page's skills: each role's built-in skills, the mission's picks and who made them. */
export function TaskSkills({ task, onChanged, onError }: { task: Task; onChanged: () => void; onError: (e: unknown) => void }) {
  // Opening the panel reloads the catalog, so skills imported meanwhile show up.
  const [open, setOpen] = useState(task.status === 'awaiting_plan_approval');
  const catalog = useCatalog(onError, open);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  useEffect(() => {
    api.agents().then(setAgents).catch(onError);
  }, [onError]);
  const finished = ['done', 'discarded', 'failed'].includes(task.status);
  const working = task.running ? roleOf(task.status) : null;
  const picked = PICKABLE_ROLES.filter((r) => task.skillPicks[r]?.skills.length);

  const save = async (role: Role, skills: string[]) => {
    try {
      await api.setTaskSkills(task.id, role, skills);
      onChanged();
    } catch (e) {
      onError(e);
    }
  };

  if (task.kind === 'review') return null;
  return (
    <section className="task-skills">
      <button type="button" className="disclosure" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'down' : 'right'} size={8} />
        <Icon name="book" />
        <span>Crew skills</span>
        <span className="hint">
          {picked.length
            ? picked.map((r) => `${r}: ${task.skillPicks[r]!.skills.join(', ')}`).join(' · ')
            : task.status === 'queued' || task.status === 'intake'
              ? 'the manager picks at intake'
              : 'no mission skills'}
        </span>
      </button>
      {open && catalog && (
        <div className="role-skills">
          {PICKABLE_ROLES.map((role) => {
            const pick = task.skillPicks[role];
            const defaults = agents.find((a) => a.role === role)?.skills ?? [];
            return (
              <div key={role} className="role-skill-row">
                <span className="role-skill-name">
                  <RoleIcon role={role} /> {role}
                </span>
                <div className="role-skill-body">
                  <SkillChips label={role} value={pick?.skills ?? []} catalog={catalog} disabled={finished || working === role} onChange={(next) => void save(role, next)} />
                  <span className="hint">
                    {pick ? (pick.by === 'owner' ? 'picked by you' : `picked by the manager${pick.why ? `: ${pick.why}` : ''}`) : ''}
                    {defaults.length ? `${pick ? ' · ' : ''}always on: ${defaults.join(', ')}` : ''}
                    {working === role ? ' · working now: changes apply to its next run' : ''}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- import from Claude Code

/** Line diff for the update preview (skills are small, so a plain LCS is fine; huge ones show old then new). */
function lineDiff(a: string, b: string): Array<{ op: ' ' | '+' | '-'; line: string }> {
  const x = a.split('\n');
  const y = b.split('\n');
  if (x.length * y.length > 4_000_000) return [...x.map((line) => ({ op: '-' as const, line })), ...y.map((line) => ({ op: '+' as const, line }))];
  const dp = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: Array<{ op: ' ' | '+' | '-'; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      out.push({ op: ' ', line: x[i++]! });
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ op: '-', line: x[i++]! });
    else out.push({ op: '+', line: y[j++]! });
  }
  while (i < x.length) out.push({ op: '-', line: x[i++]! });
  while (j < y.length) out.push({ op: '+', line: y[j++]! });
  return out;
}

const STATUS_LABEL: Record<ImportableSkill['status'], string> = {
  new: 'Import',
  imported: 'Imported',
  update: 'Update…',
  taken: 'Name taken',
};

/** Side panel listing my Claude Code skills, to copy into the office's catalog. */
export function ImportSkills({ open, onClose, onImported, onError }: { open: boolean; onClose: () => void; onImported: () => void; onError: (e: unknown) => void }) {
  const [list, setList] = useState<ImportableSkill[] | null>(null);
  const [filter, setFilter] = useState('');
  const [preview, setPreview] = useState<{ skill: ImportableSkill; current: string; incoming: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => api.importableSkills().then(setList).catch(onError);
  useEffect(() => {
    if (!open) return;
    void load();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (list ?? []).filter((s) => !q || s.name.includes(q) || s.description.toLowerCase().includes(q) || s.source.toLowerCase().includes(q));
  }, [list, filter]);
  const groups = useMemo(() => {
    const m = new Map<string, ImportableSkill[]>();
    for (const s of shown) m.set(s.source, [...(m.get(s.source) ?? []), s]);
    return [...m.entries()];
  }, [shown]);

  const doImport = async (s: ImportableSkill) => {
    setBusy(s.key);
    try {
      await api.importSkill(s.key);
      setPreview(null);
      await load();
      onImported();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(null);
    }
  };
  const showUpdate = async (s: ImportableSkill) => {
    try {
      const d = await api.importDiff(s.key);
      setPreview({ skill: s, current: d.current, incoming: d.incoming });
    } catch (e) {
      onError(e);
    }
  };

  return (
    <div className={`drawer-layer${open ? ' open' : ''}`} aria-hidden={!open}>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer drawer-wide" role="dialog" aria-modal="true" aria-label="Import skills from Claude Code">
        <header className="drawer-head">
          <Icon name="book" size={24} />
          <div>
            <h2>Import skills</h2>
            <p>From your Claude Code plugins and ~/.claude/skills. The office keeps its own copy.</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" tabIndex={open ? 0 : -1}>
            <Icon name="close" />
          </button>
        </header>
        {open && (
          <div className="drawer-body">
            {preview ? (
              <div className="update-preview">
                <h3>
                  Update {preview.skill.name} from {preview.skill.source}
                </h3>
                <p className="hint">Lines in red are in the office's copy now; green ones come from the new version. Taking it replaces the office copy, including any edits made on the Team page.</p>
                <pre className="diff">
                  {lineDiff(preview.current, preview.incoming).map((d, i) => (
                    <span key={i} className={d.op === '+' ? 'diff-add' : d.op === '-' ? 'diff-del' : ''}>
                      {d.op} {d.line}
                      {'\n'}
                    </span>
                  ))}
                </pre>
                <div className="row-buttons">
                  <button className="primary" disabled={busy === preview.skill.key} onClick={() => void doImport(preview.skill)}>
                    Take the update
                  </button>
                  <button onClick={() => setPreview(null)}>Keep the office copy</button>
                </div>
              </div>
            ) : (
              <>
                <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name, plugin or description" aria-label="Filter skills" />
                {list === null && <p className="empty">Looking for skills…</p>}
                {list !== null && list.length === 0 && <p className="empty">No Claude Code skills found on this Mac.</p>}
                {groups.map(([source, skills]) => (
                  <div key={source} className="import-group">
                    <h3>{source}</h3>
                    <ul className="import-list">
                      {skills.map((s) => (
                        <li key={s.key} className={`import-row import-${s.status}`}>
                          <div className="import-text">
                            <strong>{s.name}</strong>
                            <span className="hint import-desc" title={s.description}>
                              {s.description}
                            </span>
                            {s.wrapper && <span className="hint over">Only calls other skills, which office agents can't do: import those instead.</span>}
                            {s.extraFiles > 0 && !s.wrapper && <span className="hint">Has {s.extraFiles} extra file(s) next to it that aren't imported.</span>}
                          </div>
                          <button
                            className={s.status === 'new' ? 'primary' : ''}
                            disabled={s.status === 'imported' || s.status === 'taken' || s.wrapper || busy === s.key}
                            title={s.status === 'taken' ? 'The office already has a different skill with this name.' : s.path}
                            onClick={() => (s.status === 'update' ? void showUpdate(s) : void doImport(s))}
                          >
                            {busy === s.key ? 'Importing…' : STATUS_LABEL[s.status]}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
