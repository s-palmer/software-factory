import type { TaskSummary } from "../../../shared/api";
import { AWAITING_HUMAN, ESCALATED_STAGE, PIPELINE } from "../../../shared/lifecycle";
import { verifyAttrs } from "../../verify/core/contract";

export interface PipelineOverviewProps {
  tasks: TaskSummary[];
}

/** How many tasks sit in each stage, across the whole factory. */
export function PipelineOverview({ tasks }: PipelineOverviewProps) {
  const count = (status: string) => tasks.filter((t) => t.status === status).length;
  const escalated = count("escalated");
  const awaiting = tasks.filter((t) => AWAITING_HUMAN.has(t.status)).length;
  const done = count("done");
  const inFlight = tasks.length - done;

  return (
    <section className="overview" {...verifyAttrs({ unit: "PipelineOverview", total: tasks.length, "in-flight": inFlight, awaiting, done, escalated })}>
      <h2>Pipeline</h2>
      <p className="overview__summary">
        {tasks.length === 0 ? (
          "No tasks yet."
        ) : (
          <>
            <strong>{inFlight}</strong> in flight · <strong>{done}</strong> done
            {awaiting > 0 && (
              <>
                {" "}· <strong className="overview__awaiting">{awaiting} need a decision</strong>
              </>
            )}
          </>
        )}
      </p>
      <ol className="overview__stages">
        {PIPELINE.map((s) => (
          <li key={s.status} data-status={s.status} data-actor={s.actor} data-count={count(s.status)}>
            <span className="overview__count">{count(s.status)}</span>
            <span className="overview__label">{s.label}</span>
          </li>
        ))}
        {escalated > 0 && (
          <li data-status="escalated" data-actor={ESCALATED_STAGE.actor} data-count={escalated}>
            <span className="overview__count">{escalated}</span>
            <span className="overview__label">{ESCALATED_STAGE.label}</span>
          </li>
        )}
      </ol>
    </section>
  );
}
