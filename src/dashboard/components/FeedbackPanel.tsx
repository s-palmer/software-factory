import { useState } from "react";
import type { Artifact, FeedbackInput, TaskContext } from "../../../shared/api";
import { AWAITING_HUMAN, statusLabel, type Decision, type TaskStatus } from "../../../shared/lifecycle";
import { verifyAttrs } from "../../verify/core/contract";

export interface FeedbackPanelProps {
  status: TaskStatus;
  /** The task's context: why it escalated, and the open questions. */
  context?: Pick<TaskContext, "escalation" | "questions" | "escalatedFrom">;
  artifacts: Artifact[];
  /** Screenshot the feedback is about (e.g. the one selected in the gallery). */
  selectedArtifactId?: string | null;
  onSubmit: (input: FeedbackInput) => Promise<void> | void;
  error?: string | null;
}

export function FeedbackPanel({ status, context = {}, artifacts, selectedArtifactId = null, onSubmit, error }: FeedbackPanelProps) {
  const shots = artifacts.filter((a) => a.kind === "screenshot");
  const [comment, setComment] = useState("");
  const [artifactId, setArtifactId] = useState<string>(selectedArtifactId ?? "");
  const [submitting, setSubmitting] = useState(false);

  // Follow the gallery's selection when it changes (React's "adjust state during render" pattern).
  const [lastSelected, setLastSelected] = useState(selectedArtifactId);
  if (selectedArtifactId !== lastSelected) {
    setLastSelected(selectedArtifactId);
    setArtifactId(selectedArtifactId ?? "");
  }

  const escalated = AWAITING_HUMAN.has(status);
  const hasComment = comment.trim().length > 0;
  const questions = context.questions ?? [];

  async function send(decision: Decision) {
    setSubmitting(true);
    try {
      await onSubmit({ decision, comment: comment.trim(), artifactId: artifactId || null });
      setComment("");
    } catch {
      // Parent surfaces the error via the `error` prop; keep the comment.
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section
      className="feedback"
      {...verifyAttrs({ unit: "FeedbackPanel", status, escalated, questions: questions.length, "has-comment": hasComment, artifact: artifactId, submitting })}
    >
      <h2>Feedback</h2>
      {escalated ? (
        <div className="decision" role="group" aria-label="Decision">
          <h3>
            Escalated{context.escalatedFrom && <> from {statusLabel(context.escalatedFrom)}</>}
          </h3>
          {context.escalation ? <p className="decision__reason">{context.escalation}</p> : <p className="decision__reason decision__reason--missing">No reason was recorded.</p>}
          {questions.length > 0 && (
            <>
              <p className="decision__questions-title">Open questions</p>
              <ul className="decision__questions">
                {questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </>
          )}
          <p className="hint">Retry the stage as it is, or request changes: your comment becomes feedback for the agent.</p>
        </div>
      ) : (
        <p className="hint">You can leave a comment; the agents will see it on their next attempt.</p>
      )}
      <label htmlFor="feedback-comment">Comment</label>
      <textarea id="feedback-comment" rows={4} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What should change? Be specific; this becomes a learning." />
      {shots.length > 0 && (
        <>
          <label htmlFor="feedback-artifact">About screenshot</label>
          <select id="feedback-artifact" value={artifactId} onChange={(e) => setArtifactId(e.target.value)}>
            <option value="">(whole task)</option>
            {shots.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label || s.path}
              </option>
            ))}
          </select>
        </>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="feedback__actions">
        {escalated && (
          <>
            <button type="button" className="approve" disabled={submitting} onClick={() => send("approve")}>
              Retry stage
            </button>
            <button type="button" className="request-changes" disabled={submitting || !hasComment} onClick={() => send("request_changes")}>
              Request changes
            </button>
          </>
        )}
        <button type="button" className="comment" disabled={submitting || !hasComment} onClick={() => send("comment")}>
          Comment
        </button>
      </div>
    </section>
  );
}
