import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Gate, type OfficeEvent, type TaskDetail } from './api';
import { flushReviewEdits, ReviewPanel } from './Review';
import { Briefing } from './Briefing';
import { TaskSkills } from './Skills';
import { Icon, RoleIcon } from './icons';
import { DiffView, Doc, duration, formatTokens, StageTrack, StatusBadge, timeAgo } from './ui';

type Tab = 'docs' | 'diff' | 'activity' | 'runs';

const TERMINAL = ['done', 'discarded', 'failed', 'pushing', 'pr_open', 'retro'];

function Steer({ taskId, running, onError, onReplanned }: { taskId: number; running: boolean; onError: (e: unknown) => void; onReplanned: () => void }) {
  const [text, setText] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const send = async (kind: 'steer' | 'replan') => {
    if (!text.trim()) return;
    try {
      if (kind === 'steer') {
        const r = await api.steer(taskId, text);
        setSent(r.delivered === 'live' ? 'Sent to the running agent.' : 'Saved: the next agent step will get it.');
      } else {
        await api.replan(taskId, text);
        setSent('Sent back to the architect for a new plan.');
        onReplanned();
      }
      setText('');
    } catch (e) {
      onError(e);
    }
  };
  return (
    <div className="steer">
      <input
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setSent(null);
        }}
        onKeyDown={(e) => e.key === 'Enter' && void send('steer')}
        placeholder={running ? 'Message the agent that is working now…' : 'Note for the next agent step…'}
      />
      <button disabled={!text.trim()} onClick={() => send('steer')}>
        <Icon name="play" size={8} /> Send
      </button>
      <button disabled={!text.trim()} onClick={() => send('replan')} title="Stop and ask the architect for a new plan, with this as the reason">
        New plan
      </button>
      {sent && <span className="hint">{sent}</span>}
    </div>
  );
}

const REFRESH_ON = new Set([
  'step_start',
  'step_end',
  'gate',
  'gate_decided',
  'alert',
  'pr_opened',
  'stopped',
  'resumed',
  'worktree',
  'paused',
  'question_round',
  'question_answered',
  'briefing_parked',
  'briefing_resumed',
  'briefing_decided',
  'skills_picked',
]);

export function TaskView({ id, lastEvent, onError }: { id: number; lastEvent: OfficeEvent | null; onError: (e: unknown) => void }) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [tab, setTab] = useState<Tab>('docs');
  const [events, setEvents] = useState<OfficeEvent[]>([]);
  const [docFile, setDocFile] = useState<string | null>(null);
  const [docText, setDocText] = useState('');
  const [diff, setDiff] = useState('');

  const load = useCallback(() => api.task(id).then(setDetail).catch(onError), [id, onError]);

  useEffect(() => {
    void load();
    api.events(id).then(setEvents).catch(onError);
  }, [id, load, onError]);

  useEffect(() => {
    if (!lastEvent || lastEvent.taskId !== id) return;
    setEvents((prev) => (prev.some((e) => e.id === lastEvent.id) ? prev : [...prev, lastEvent]));
    if (REFRESH_ON.has(lastEvent.type)) void load();
  }, [lastEvent, id, load]);

  // Default to the newest document.
  const latestByName = useMemo(() => {
    const map = new Map<string, { file: string; version: number }[]>();
    for (const d of detail?.docs ?? []) map.set(d.name, [...(map.get(d.name) ?? []), d]);
    return map;
  }, [detail?.docs]);

  useEffect(() => {
    if (!detail || docFile) return;
    const order = ['plan', 'review', 'test-report', 'changes', 'blocked', 'diagnosis', 'research', 'task', 'pr', 'retro'];
    const newest = [...(detail.docs ?? [])].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))[0];
    if (newest) setDocFile((latestByName.get(newest.name) ?? []).at(-1)?.file ?? null);
  }, [detail, docFile, latestByName]);

  useEffect(() => {
    if (docFile) api.doc(id, docFile).then(setDocText).catch(onError);
  }, [id, docFile, detail?.docs.length, onError]);

  useEffect(() => {
    if (tab === 'diff') api.diff(id).then(setDiff).catch(onError);
  }, [tab, id, detail?.task.updatedAt, onError]);

  if (!detail) return <p className="empty">Loading…</p>;
  const { task, repo, runs, gates, alerts } = detail;
  const pending = gates.filter((g) => g.status === 'pending');

  const act = async (action: Parameters<typeof api.action>[1]) => {
    if (action === 'discard' && !confirm('Discard this task and delete its worktree? The branch stays.')) return;
    try {
      await api.action(id, action);
      await load();
    } catch (e) {
      onError(e);
    }
  };

  const canStop = !['done', 'discarded', 'failed', 'stopped'].includes(task.status);
  const canResume = ['stopped', 'paused', 'blocked'].includes(task.status);
  const canDone = ['pr_open', 'blocked', 'stopped', 'awaiting_push_approval', 'awaiting_review_post'].includes(task.status);

  return (
    <div className="task-view">
      <a href="#/" className="back">
        <Icon name="left" size={8} /> Mission board
      </a>
      <header className="task-header">
        <div className="card-top">
          <span className="task-id">Mission #{task.id}</span>
          <span className="repo-chip">{repo.name}</span>
          {task.size && <span className="size" title={`Size ${task.size}`}>{task.size}</span>}
          <span className={`kind kind-${task.kind}`}>{task.kind}</span>
        </div>
        <h1>{task.title}</h1>
        <StageTrack task={task} labels />
        <div className="task-facts">
          <StatusBadge status={task.status} running={task.running} />
          {task.branch && <code>{task.branch}</code>}
          {task.prUrl && (
            <a href={task.prUrl} target="_blank" rel="noreferrer">
              Draft PR <Icon name="link" size={8} />
            </a>
          )}
          <span className="fact">
            <Icon name="gem" size={8} /> {formatTokens(task.tokens)} tokens{task.tokenEstimate ? ` / est. ${formatTokens(task.tokenEstimate)}` : ''}
          </span>
          {task.loopCount > 0 && <span className="fact">fix loop {task.loopCount}/2</span>}
          {task.replanCount > 0 && <span className="fact">re-plan {task.replanCount}/2</span>}
          {task.grill && (
            <span className="fact" title={task.grillReason ?? ''}>
              <Icon name="question" size={8} /> briefing on{task.grillReason ? `: ${task.grillReason}` : ''}
            </span>
          )}
        </div>
        {task.statusNote && <p className="note">{task.statusNote}</p>}
      </header>

      <Briefing task={task} questions={detail.questions} onChanged={load} onError={onError} />

      {pending
        .filter((g) => g.kind !== 'question')
        .map((g) => (
          <GateBar key={g.id} gate={g} onDone={load} onError={onError} />
        ))}

      <div className="actions">
        {canStop && <button onClick={() => act('stop')}>Stop</button>}
        {canResume && (
          <button className="primary" onClick={() => act('resume')}>
            <Icon name="play" size={8} /> Resume{task.resumeStatus ? ` (${task.resumeStatus.replace(/_/g, ' ')})` : ''}
          </button>
        )}
        {canDone && <button onClick={() => act('done')}>Mark done</button>}
        {task.worktreePath && <button onClick={() => act('takeover')}>Take over in editor</button>}
        {task.status !== 'discarded' && task.status !== 'done' && (
          <button className="danger" onClick={() => act('discard')}>
            Discard
          </button>
        )}
      </div>

      <TaskSkills task={task} onChanged={load} onError={onError} />

      {task.kind === 'review' && <ReviewPanel task={task} comments={detail.reviewComments} onChanged={load} onError={onError} />}

      {!TERMINAL.includes(task.status) && task.kind !== 'review' && <Steer taskId={id} running={task.running} onError={onError} onReplanned={load} />}

      <Alerts alerts={alerts} />

      <nav className="tabs">
        {(['docs', 'diff', 'activity', 'runs'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {{ docs: 'Documents', diff: 'Diff', activity: 'Activity', runs: 'Runs & tokens' }[t]}
          </button>
        ))}
      </nav>

      {tab === 'docs' && (
        <div className="docs">
          {latestByName.size === 0 ? (
            <p className="empty">No documents yet. The request:</p>
          ) : (
            <div className="doc-picker">
              {[...latestByName.entries()].map(([name, versions]) => (
                <span key={name} className="doc-group">
                  {versions.map((v) => (
                    <button key={v.file} className={docFile === v.file ? 'active' : ''} onClick={() => setDocFile(v.file)}>
                      {name}
                      {versions.length > 1 ? ` v${v.version}` : ''}
                    </button>
                  ))}
                </span>
              ))}
            </div>
          )}
          {latestByName.size === 0 ? <pre className="request">{task.input}</pre> : <Doc text={docText} />}
        </div>
      )}
      {tab === 'diff' && <DiffView diff={diff} />}
      {tab === 'activity' && <Activity events={events} />}
      {tab === 'runs' && <Runs runs={runs} />}
    </div>
  );
}

/** What went sideways. The newest two; the rest on request, so old alerts don't bury the page. */
function Alerts({ alerts }: { alerts: OfficeEvent[] }) {
  const [all, setAll] = useState(false);
  if (alerts.length === 0) return null;
  const shown = all ? alerts : alerts.slice(-2);
  return (
    <div className="alerts">
      <ul>
        {shown.map((a) => (
          <li key={a.id} className={`alert alert-${String(a.payload.kind)}${all ? '' : ' alert-clamped'}`}>
            <strong>{String(a.payload.kind).replace(/_/g, ' ')}</strong>
            <span className="alert-msg">{String(a.payload.message ?? '')}</span>
            <span className="when">{timeAgo(a.at)}</span>
          </li>
        ))}
      </ul>
      {alerts.length > 2 && (
        <button className="link" onClick={() => setAll(!all)}>
          {all ? 'Show only the latest' : `Show all ${alerts.length} alerts`}
        </button>
      )}
    </div>
  );
}

function GateBar({ gate, onDone, onError }: { gate: Gate; onDone: () => void; onError: (e: unknown) => void }) {
  const [comment, setComment] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const decide = async (decision: string) => {
    setBusy(true);
    try {
      if (gate.kind === 'review_post') await flushReviewEdits();
      await api.decide(gate.id, decision, comment || undefined);
      onDone();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  if (gate.kind === 'command') {
    return (
      <div className="gate gate-command">
        <div className="gate-title">
          <Icon name="warn" /> An agent wants to run a command that isn't on the allow-list
        </div>
        <pre>{gate.subject}</pre>
        <div className="gate-buttons">
          <button disabled={busy} onClick={() => decide('allow_once')}>
            Allow once
          </button>
          <button disabled={busy} className="primary" onClick={() => decide('allow_always')}>
            Always for this repo
          </button>
          <button disabled={busy} className="danger" onClick={() => decide('deny')}>
            Deny
          </button>
        </div>
      </div>
    );
  }

  const label =
    gate.kind === 'plan'
      ? 'Approve the plan?'
      : gate.kind === 'review_post'
        ? 'Post this review to GitHub?'
        : 'Push the branch and open a draft PR?';
  const approveLabel = gate.kind === 'plan' ? 'Approve plan' : gate.kind === 'review_post' ? 'Post review' : 'Push & open draft PR';
  const rejectHint =
    gate.kind === 'plan'
      ? 'What should the architect change?'
      : gate.kind === 'review_post'
        ? 'What should the reviewer redo?'
        : 'What should the coder fix before pushing?';
  return (
    <div className="gate">
      <div className="gate-title">
        <Icon name="warn" /> {label}
      </div>
      {gate.kind === 'plan' && <p className="gate-hint">Read the plan below. Approving starts the coder.</p>}
      {gate.kind === 'review_post' && <p className="gate-hint">Edit or delete comments below first. It posts under the repo's GitHub account.</p>}
      {rejecting && (
        <textarea
          autoFocus
          placeholder={rejectHint}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      )}
      <div className="gate-buttons">
        {!rejecting && (
          <button disabled={busy} className="primary" onClick={() => decide('approve')}>
            {approveLabel}
          </button>
        )}
        {rejecting ? (
          <>
            <button disabled={busy || !comment.trim()} className="primary" onClick={() => decide('reject')}>
              Send back
            </button>
            <button onClick={() => setRejecting(false)}>Cancel</button>
          </>
        ) : (
          <button disabled={busy} onClick={() => setRejecting(true)}>
            Reject with comment
          </button>
        )}
      </div>
    </div>
  );
}

function Activity({ events }: { events: OfficeEvent[] }) {
  const [showTools, setShowTools] = useState(false);
  const shown = events.filter((e) => showTools || !['tool', 'text'].includes(e.type));
  return (
    <div className="activity">
      <label className="toggle">
        <input type="checkbox" checked={showTools} onChange={(e) => setShowTools(e.target.checked)} /> Show tool calls and agent messages
      </label>
      <ol>
        {[...shown].reverse().map((e) => (
          <li key={e.id} className={`ev ev-${e.type}`}>
            <span className="when">{new Date(e.at).toLocaleTimeString()}</span>
            <span className="ev-type">{e.type.replace(/_/g, ' ')}</span>
            <span className="ev-body">{describe(e)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function describe(e: OfficeEvent): string {
  const p = e.payload;
  switch (e.type) {
    case 'step_start':
      return `${p.role} started (${p.model}${p.effort ? `, ${p.effort}` : ''})`;
    case 'step_end':
      return `${p.role} ${p.status}${p.error ? `: ${p.error}` : ''}`;
    case 'tool':
      return `${p.tool} ${p.input}`;
    case 'text':
      return String(p.text);
    case 'tool_denied':
      return `${p.tool} blocked: ${p.reason}`;
    case 'gate':
      return `${p.kind} gate ${p.auto ? 'auto-approved' : 'opened'}${p.subject ? `: ${p.subject}` : ''}`;
    case 'gate_decided':
      return `${p.kind}: ${p.decision}${p.comment ? ` — ${p.comment}` : ''}`;
    case 'alert':
      return String(p.message);
    case 'correction':
      return `output sent back for a fix: ${p.reason}`;
    default:
      return Object.keys(p).length ? JSON.stringify(p) : '';
  }
}

function Runs({ runs }: { runs: TaskDetail['runs'] }) {
  const total = runs.reduce((s, r) => s + r.inputTokens + r.outputTokens + r.cacheWriteTokens, 0);
  return (
    <div className="runs">
      <table>
        <thead>
          <tr>
            <th>Step</th>
            <th>Model</th>
            <th>Status</th>
            <th>In</th>
            <th>Out</th>
            <th>Cache r/w</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td>
                <span className="run-role">
                  <RoleIcon role={r.role} /> {r.role}
                </span>
              </td>
              <td>
                {r.model.replace('claude-', '')}
                {r.effort ? ` · ${r.effort}` : ''}
              </td>
              <td title={r.error ?? ''}>
                <span className={`run-status run-${r.status}`}>{r.status}</span>
              </td>
              <td>{formatTokens(r.inputTokens)}</td>
              <td>{formatTokens(r.outputTokens)}</td>
              <td>
                {formatTokens(r.cacheReadTokens)} / {formatTokens(r.cacheWriteTokens)}
              </td>
              <td>{duration(r.durationMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">Total (input + output + cache writes): {formatTokens(total)} tokens. Cache reads are cheap and not counted.</p>
    </div>
  );
}
