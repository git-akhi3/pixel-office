import { useEffect, useMemo, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, type Question, type Task } from './api';
import { Icon, RoleIcon } from './icons';

const answered = (q: Question) => q.answer !== null || q.delegated;
const answerLabel = (q: Question) => (q.delegated ? `You decide${q.recommended ? ` (${q.recommended})` : ''}` : (q.answer ?? ''));

/**
 * The architect's briefing on the task page: the open round one question at a time, like a chat,
 * with the answered questions above it. Slack shows the same questions; the first answer counts.
 */
export function Briefing({ task, questions, onChanged, onError }: { task: Task; questions: Question[]; onChanged: () => void; onError: (e: unknown) => void }) {
  const openGate = task.pendingGates.find((g) => g.kind === 'question');
  const round = useMemo(() => (openGate ? questions.filter((q) => q.gateId === openGate.id) : []), [questions, openGate]);
  const current = round.find((q) => !answered(q));
  const history = questions.filter((q) => answered(q) || !openGate || q.gateId !== openGate.id);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  useEffect(() => setText(''), [current?.id]);

  if (!task.grill && questions.length === 0) return null;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };
  const answer = (value: { answer?: string; delegate?: boolean }) => current && run(() => api.answerQuestion(current.id, value));
  const roundAnswered = round.filter(answered).length;

  return (
    <section className={`briefing${current ? ' briefing-open' : ''}`} aria-label="Briefing">
      <header className="briefing-head">
        <RoleIcon role="architect" />
        <div>
          <h2>Briefing</h2>
          <p className="hint">
            {current
              ? `The architect has questions before it ${task.status === 'splitting' ? 'splits this into milestones' : 'goes on'}. Answer here or in Slack.`
              : questions.length
                ? `${questions.filter(answered).length} answered${task.running && task.status === 'planning' ? ' · the architect is planning' : task.running && task.status === 'splitting' ? ' · the architect is splitting it into milestones' : ''}`
                : (task.grillReason ?? 'The architect will interview you first.')}
          </p>
        </div>
        {questions.some(answered) && (
          <button className="link" onClick={() => setShowHistory(!showHistory)} aria-expanded={showHistory}>
            {showHistory ? 'Hide answers' : `Answers so far (${questions.filter(answered).length})`}
          </button>
        )}
      </header>

      {showHistory && (
        <ol className="qa-history">
          {history.filter(answered).map((q) => (
            <li key={q.id}>
              <span className="qa-round">R{q.round}</span>
              <span className="qa-title">{q.title}</span>
              <span className="qa-answer">
                {answerLabel(q)}
                {q.answeredVia === 'slack' && <span className="tag">Slack</span>}
              </span>
            </li>
          ))}
        </ol>
      )}

      {current && (
        <div className="question-card">
          <div className="question-progress">
            <span>
              Round {current.round} · question {current.idx + 1} of {round.length}
            </span>
            <span className="pips" aria-hidden>
              {round.map((q) => (
                <span key={q.id} className={answered(q) ? 'on' : q.id === current.id ? 'now' : ''} />
              ))}
            </span>
          </div>
          <h3>
            <Icon name="question" /> {current.title}
          </h3>
          <div className="question-body">
            <Markdown remarkPlugins={[remarkGfm]}>{current.body}</Markdown>
          </div>
          {current.recommended && (
            <div className="recommended">
              <span className="field-label">Recommended</span>
              <span>{current.recommended}</span>
            </div>
          )}
          <div className="answer-options">
            {current.recommended && (
              <button className="primary" disabled={busy} onClick={() => void answer({ answer: current.recommended! })}>
                <Icon name="check" size={8} /> Lock it in
              </button>
            )}
            {current.options.map((o) => (
              <button key={o} className="chip" disabled={busy} onClick={() => void answer({ answer: o })}>
                {o}
              </button>
            ))}
            <button disabled={busy} onClick={() => void answer({ delegate: true })} title="The architect uses its recommendation">
              You decide
            </button>
          </div>
          <form
            className="answer-own"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) void answer({ answer: text.trim() });
            }}
          >
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Or answer in your own words…" aria-label="Your answer" />
            <button disabled={busy || !text.trim()}>Answer</button>
          </form>
          <div className="round-actions">
            {roundAnswered > 0 && (
              <button className="link" disabled={busy} onClick={() => void run(() => api.briefing(task.id, 'send'))}>
                Send what I've answered ({roundAnswered} of {round.length})
              </button>
            )}
            <button className="link danger-link" disabled={busy} onClick={() => void run(() => api.briefing(task.id, 'enough'))}>
              {task.status === 'splitting' ? 'Enough, split it now' : 'Enough, start planning'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
