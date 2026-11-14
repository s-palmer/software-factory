import type { TaskContext } from "../../../shared/api";
import { verifyAttrs } from "../../verify/core/contract";

export interface TaskNotesProps {
  context: Pick<TaskContext, "decisions" | "risk">;
}

/** What the decider settled on the task's behalf, and why the change counts as high risk. Hidden when there is neither. */
export function TaskNotes({ context }: TaskNotesProps) {
  const decisions = context.decisions ?? [];
  const highRisk = context.risk?.level === "high";
  const reasons = highRisk ? (context.risk?.reasons ?? []) : [];
  const empty = decisions.length === 0 && !highRisk;
  return (
    <section className="task-notes" hidden={empty} {...verifyAttrs({ unit: "TaskNotes", decisions: decisions.length, risk: context.risk?.level ?? "none", reasons: reasons.length })}>
      {highRisk && (
        <div className="task-notes__risk">
          <h2>High risk</h2>
          <p>The pull request gets the risk:high label, so the merge agent knows to look closer.</p>
          {reasons.length > 0 ? (
            <ul className="task-notes__reasons">
              {reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          ) : (
            <p className="task-notes__no-reasons">No reasons recorded.</p>
          )}
        </div>
      )}
      {decisions.length > 0 && (
        <div className="task-notes__decisions">
          <h2>Decisions made for you</h2>
          <ul>
            {decisions.map((d, i) => (
              <li key={i} className="task-notes__decision">
                <span className="task-notes__stage">{d.stage.replaceAll("_", " ")}</span>
                <p className="task-notes__question">{d.question}</p>
                <p className="task-notes__answer">{d.answer}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
