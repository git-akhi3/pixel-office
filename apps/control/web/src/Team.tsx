import { useCallback, useEffect, useState } from 'react';
import { api, type AgentInfo, type SkillInfo } from './api';

const NEW_SKILL = (name: string) => `---
name: ${name}
description: One line on when this skill applies.
---
What the agent should do, step by step. Keep it short: it is added to the agent's instructions on every run.
`;

/** Agents and skills. My edits are saved in ~/.office and override the built-in defaults. */
export function Team({ onError }: { onError: (e: unknown) => void }) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [editing, setEditing] = useState<{ kind: 'agent' | 'skill'; key: string; text: string; isNew?: boolean } | null>(null);
  const [newSkill, setNewSkill] = useState('');

  const load = useCallback(() => {
    api.agents().then(setAgents).catch(onError);
    api.skills().then(setSkills).catch(onError);
  }, [onError]);
  useEffect(load, [load]);

  const save = async () => {
    if (!editing) return;
    try {
      if (editing.kind === 'agent') await api.saveAgent(editing.key, editing.text);
      else await api.saveSkill(editing.key, editing.text);
      setEditing(null);
      load();
    } catch (e) {
      onError(e);
    }
  };

  const act = async (fn: () => Promise<unknown>, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    try {
      await fn();
      load();
    } catch (e) {
      onError(e);
    }
  };

  if (editing) {
    return (
      <div className="panel panel-wide">
        <h1>
          {editing.kind === 'agent' ? `Agent: ${editing.key}` : `Skill: ${editing.key}`}
          {editing.isNew && ' (new)'}
        </h1>
        <p className="hint">
          {editing.kind === 'agent'
            ? 'Front matter: model, effort (low…max), tools, write (none | tests | all), skills, maxTurns. Below it: the instructions. Saving validates the file; running steps keep the version they started with.'
            : 'Front matter: name and description. Below it: the instructions added to every agent that uses this skill.'}
        </p>
        <textarea className="code-editor" rows={24} value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} spellCheck={false} />
        <div className="gate-buttons">
          <button className="primary" onClick={save}>
            Save
          </button>
          <button onClick={() => setEditing(null)}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="panel panel-wide">
      <h1>Team</h1>
      <p className="hint">Changes are saved in ~/.office and override the built-in definitions. "Reset" goes back to the built-in version.</p>
      <table className="team">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Model</th>
            <th>Tools</th>
            <th>Skills</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.role}>
              <td>
                <strong>{a.role}</strong>
                {a.custom && <span className="kind kind-review">edited</span>}
                <div className="hint">{a.description}</div>
              </td>
              <td>
                {a.model.replace('claude-', '')}
                {a.effort ? ` · ${a.effort}` : ''}
              </td>
              <td>
                <span className="hint">{a.tools.join(', ')}</span>
              </td>
              <td>
                <span className="hint">{a.skills.join(', ') || '–'}</span>
              </td>
              <td>
                <div className="row-buttons">
                  <button onClick={() => setEditing({ kind: 'agent', key: a.role, text: a.text })}>Edit</button>
                  {a.custom && (
                    <button onClick={() => act(() => api.resetAgent(a.role), `Reset ${a.role} to the built-in version?`)}>Reset</button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Skills</h2>
      <ul className="repo-list">
        {skills.map((s) => (
          <li key={s.name}>
            <div>
              <strong>{s.name}</strong> {s.custom ? <span className="kind kind-review">mine</span> : <span className="kind">built-in</span>}
              <div className="hint">{s.description}</div>
            </div>
            <div className="row-buttons">
              <button onClick={() => setEditing({ kind: 'skill', key: s.name, text: s.text })}>Edit</button>
              <button
                title="Copy into ~/.claude/skills so your everyday Claude Code sessions can use it too"
                onClick={() =>
                  act(async () => {
                    const r = await api.installSkillGlobally(s.name);
                    alert(`Installed to ${r.path}`);
                  }, `Also install "${s.name}" into ~/.claude/skills for your own Claude Code sessions?`)
                }
              >
                Install globally
              </button>
              {s.custom && (
                <button className="danger" onClick={() => act(() => api.deleteSkill(s.name), `Delete your skill "${s.name}"?`)}>
                  Delete
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <form
        className="steer"
        onSubmit={(e) => {
          e.preventDefault();
          const name = newSkill.trim().toLowerCase();
          if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(name)) return onError(new Error('Skill names use lowercase letters, digits and dashes.'));
          setEditing({ kind: 'skill', key: name, text: NEW_SKILL(name), isNew: true });
          setNewSkill('');
        }}
      >
        <input value={newSkill} onChange={(e) => setNewSkill(e.target.value)} placeholder="new-skill-name" />
        <button disabled={!newSkill.trim()}>New skill</button>
      </form>
      <p className="hint">Attach a skill to an agent in its front matter (skills: [...]), or to one repo's agents under Repos → Edit.</p>
    </div>
  );
}
