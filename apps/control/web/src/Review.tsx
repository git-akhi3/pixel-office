import { useEffect, useState } from 'react';
import { api, type ReviewComment, type Task } from './api';

// Edits save on blur, which fires just before a click on "Post review". The gate waits for these first.
const pendingSaves = new Set<Promise<unknown>>();
export const flushReviewEdits = () => Promise.all([...pendingSaves]);
function track<T>(p: Promise<T>): Promise<T> {
  pendingSaves.add(p);
  void p.finally(() => pendingSaves.delete(p)).catch(() => {});
  return p;
}

/** The draft review: I edit the summary and each comment before anything is posted. */
export function ReviewPanel({
  task,
  comments,
  onChanged,
  onError,
}: {
  task: Task;
  comments: ReviewComment[];
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const editable = task.status === 'awaiting_review_post';
  const [summary, setSummary] = useState(task.reviewSummary ?? '');
  useEffect(() => setSummary(task.reviewSummary ?? ''), [task.reviewSummary]);

  const saveSummary = async () => {
    if (summary === (task.reviewSummary ?? '')) return;
    try {
      await track(api.editSummary(task.id, summary));
      onChanged();
    } catch (e) {
      onError(e);
    }
  };
  const blocking = comments.filter((c) => !c.deleted && c.severity === 'blocking').length;

  const fixIt = async () => {
    try {
      const t = await api.fixIt(task.id);
      location.hash = `#/task/${t.id}`;
    } catch (e) {
      onError(e);
    }
  };

  return (
    <section className="review">
      <div className="review-head">
        <span>
          {task.prRepo}#{task.prNumber} by <strong>{task.prAuthor}</strong>
        </span>
        {task.reviewPostedUrl && (
          <a href={task.reviewPostedUrl} target="_blank" rel="noreferrer">
            Posted review ↗
          </a>
        )}
        {blocking > 0 && task.status !== 'reviewing_pr' && (
          <button
            onClick={fixIt}
            title="For your own PRs: a coder task fixes the blocking findings, as a draft PR into this PR's branch"
          >
            Fix it ({blocking} blocking)
          </button>
        )}
      </div>
      <label>
        Review summary
        <textarea
          rows={4}
          value={summary}
          disabled={!editable}
          onChange={(e) => setSummary(e.target.value)}
          onBlur={saveSummary}
        />
      </label>
      {comments.length === 0 && <p className="empty">No line comments.</p>}
      <ul className="comments">
        {comments.map((c) => (
          <CommentRow key={c.id} comment={c} editable={editable} onChanged={onChanged} onError={onError} />
        ))}
      </ul>
      {editable && (
        <p className="hint">
          Edits save as you go. Comments on lines outside the PR's diff are moved into the summary when
          posting, since GitHub only accepts line comments inside the diff. Posting always sends a plain
          "comment" review: approving or requesting changes stays your click on GitHub.
        </p>
      )}
    </section>
  );
}

function CommentRow({
  comment,
  editable,
  onChanged,
  onError,
}: {
  comment: ReviewComment;
  editable: boolean;
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const [body, setBody] = useState(comment.body);
  const save = async (patch: { body?: string; deleted?: boolean }) => {
    try {
      await track(api.editComment(comment.id, patch));
      onChanged();
    } catch (e) {
      onError(e);
    }
  };
  return (
    <li className={`comment ${comment.deleted ? 'comment-deleted' : ''}`}>
      <div className="comment-head">
        <span className={`sev sev-${comment.severity}`}>{comment.severity}</span>
        <code>
          {comment.path}:{comment.line}
        </code>
        {editable && (
          <button className="link" onClick={() => save({ deleted: !comment.deleted })}>
            {comment.deleted ? 'Restore' : 'Delete'}
          </button>
        )}
      </div>
      <textarea
        rows={2}
        value={body}
        disabled={!editable || comment.deleted}
        onChange={(e) => setBody(e.target.value)}
        onBlur={() => body.trim() && body !== comment.body && save({ body })}
      />
    </li>
  );
}
