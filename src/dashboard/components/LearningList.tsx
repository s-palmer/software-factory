import { useState } from "react";
import type { Learning, LearningKind, UpdateLearningInput } from "../../../shared/api";
import { verifyAttrs } from "../../verify/core/contract";
import { formatWhen } from "../time";

export interface LearningListProps {
  learnings: Learning[];
  onSave: (id: string, change: UpdateLearningInput) => Promise<void> | void;
  onApply: () => Promise<void> | void;
  busy?: boolean;
  /** The result of the last action. */
  message?: { ok: boolean; text: string } | null;
}

/**
 * The retro's learnings. Proposed ones can be edited, approved or rejected; approved ones are applied together:
 * factory learnings go into the instructions every run reads, codebase learnings become tasks.
 */
export function LearningList({ learnings, onSave, onApply, busy = false, message }: LearningListProps) {
  const proposed = learnings.filter((l) => l.status === "open" && !l.appliedAt);
  const toApply = learnings.filter((l) => l.status === "approved" && !l.appliedAt);
  const applied = learnings.filter((l) => l.appliedAt);
  const rejected = learnings.filter((l) => l.status === "rejected" && !l.appliedAt);

  return (
    <section className="learnings" {...verifyAttrs({ unit: "LearningList", proposed: proposed.length, approved: toApply.length, applied: applied.length, rejected: rejected.length })}>
      <h2>Learnings</h2>
      <p className="hint">
        After each task ends, a short retro proposes lessons. Nothing reaches an agent until you approve it. Factory learnings go into the instructions every
        later run reads; codebase learnings become a task that adds the rule to the repository's own instructions, through a pull request.
      </p>
      {message && (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "learnings__message" : "learnings__message error"}>
          {message.text}
        </p>
      )}

      <h3>Proposed ({proposed.length})</h3>
      {proposed.length === 0 ? <p className="hint">Nothing to review.</p> : (
        <ul className="learnings__list">
          {proposed.map((l) => (
            <ProposedLearning key={l.id} learning={l} onSave={onSave} busy={busy} />
          ))}
        </ul>
      )}

      <div className="learnings__apply-head">
        <h3>Approved, not applied ({toApply.length})</h3>
        <button type="button" className="learnings__apply" disabled={toApply.length === 0 || busy} onClick={() => onApply()}>
          Apply approved learnings
        </button>
      </div>
      {toApply.length > 0 && (
        <ul className="learnings__list">
          {toApply.map((l) => (
            <li key={l.id} className="learnings__item" data-learning-id={l.id}>
              <span className="learnings__kind">{kindLabel(l)}</span> {l.summary}{" "}
              <button type="button" className="learnings__undo" disabled={busy} onClick={() => onSave(l.id, { status: "open" })}>
                Undo
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3>Applied ({applied.length})</h3>
      {applied.length > 0 && (
        <ul className="learnings__list">
          {applied.map((l) => (
            <li key={l.id} className="learnings__item" data-learning-id={l.id}>
              <span className="learnings__kind">{kindLabel(l)}</span> {l.summary} <span className="hint">({appliedLabel(l)})</span>
            </li>
          ))}
        </ul>
      )}
      {rejected.length > 0 && <p className="hint learnings__rejected">{rejected.length} rejected.</p>}
    </section>
  );
}

const kindLabel = (l: Pick<Learning, "kind" | "target">) => (l.kind === "codebase" ? `Codebase: ${l.target ?? "CLAUDE.md"}` : "Factory");

function appliedLabel(l: Learning) {
  const when = l.appliedAt ? `, ${formatWhen(l.appliedAt)}` : "";
  if (l.appliedTo?.startsWith("task:")) {
    const id = l.appliedTo.slice(5);
    return (
      <>
        as <a href={`/tasks/${encodeURIComponent(id)}`}>a task</a>
        {when}
      </>
    );
  }
  return `in the learnings file${when}`;
}

function ProposedLearning({ learning, onSave, busy }: { learning: Learning; onSave: LearningListProps["onSave"]; busy: boolean }) {
  const [summary, setSummary] = useState(learning.summary);
  const [kind, setKind] = useState<LearningKind>(learning.kind);
  const [target, setTarget] = useState(learning.target ?? "CLAUDE.md");
  const id = (field: string) => `learning-${field}-${learning.id}`;
  const decide = (status: "approved" | "rejected") =>
    onSave(learning.id, { summary: summary.trim() || learning.summary, kind, target: kind === "codebase" ? target.trim() || "CLAUDE.md" : null, status });

  return (
    <li className="learnings__proposed" data-learning-id={learning.id}>
      <p className="hint">
        From <a href={`/tasks/${encodeURIComponent(learning.sourceTaskId)}`}>a task</a>, {formatWhen(learning.createdAt)}
      </p>
      <label htmlFor={id("summary")}>Learning</label>
      <textarea id={id("summary")} rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} />
      <div className="learnings__fields">
        <label htmlFor={id("kind")}>Kind</label>
        <select id={id("kind")} value={kind} onChange={(e) => setKind(e.target.value as LearningKind)}>
          <option value="factory">Factory: how the agents work here</option>
          <option value="codebase">Codebase: a rule for the repository's instructions</option>
        </select>
        {kind === "codebase" && (
          <>
            <label htmlFor={id("target")}>File</label>
            <input id={id("target")} type="text" value={target} onChange={(e) => setTarget(e.target.value)} />
          </>
        )}
      </div>
      {learning.evidence.length > 0 && (
        <details>
          <summary>Why</summary>
          <ul>
            {learning.evidence.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="learnings__actions">
        <button type="button" className="learnings__approve" disabled={busy} onClick={() => decide("approved")}>
          Approve
        </button>
        <button type="button" className="learnings__reject" disabled={busy} onClick={() => decide("rejected")}>
          Reject
        </button>
      </div>
    </li>
  );
}
