import { pipelineFor, pipelinePosition, type Actor, type TaskStatus } from "../../../shared/lifecycle";
import { verifyAttrs } from "../../verify/core/contract";

const WHO: Record<Actor, string> = { agent: "an agent", system: "the factory" };

export interface PipelineProgressProps {
  status: TaskStatus;
  /** From the task's context. `false` leaves the browser check out; unknown keeps it. */
  needsBrowser?: boolean;
  /** One-line version for tables. */
  compact?: boolean;
}

/** Where a task is in the pipeline, who is acting on it, and what comes next. */
export function PipelineProgress({ status, needsBrowser, compact = false }: PipelineProgressProps) {
  const { index, total, stage, next } = pipelinePosition(status, { needsBrowser });
  const stages = pipelineFor({ needsBrowser, current: status });
  const escalated = index === -1;
  const step = escalated ? 0 : index + 1;
  const attrs = verifyAttrs({
    unit: "PipelineProgress",
    status,
    "needs-browser": needsBrowser === undefined ? "unknown" : needsBrowser,
    step,
    total,
    actor: stage.actor,
    next: next?.status ?? "",
  });

  if (compact) {
    return (
      <div className="pipeline pipeline--compact" {...attrs}>
        <progress value={step} max={total} aria-label={`Stage ${step} of ${total}`} />
        <span className="pipeline__caption">
          {escalated ? stage.label : `${step}/${total} ${stage.label}`}
          {next && !escalated && <span className="pipeline__next"> → {next.label}</span>}
        </span>
      </div>
    );
  }

  return (
    <section className="pipeline" {...attrs} aria-label="Pipeline progress">
      <ol className="pipeline__steps">
        {stages.map((s, i) => {
          const state = escalated ? "upcoming" : i < index ? "done" : i === index ? "current" : "upcoming";
          return (
            <li key={s.status} data-status={s.status} data-state={state} data-actor={s.actor} aria-current={state === "current" ? "step" : undefined}>
              <span className="pipeline__dot" aria-hidden="true">{state === "done" ? "✓" : i + 1}</span>
              <span className="pipeline__label">{s.label}</span>
            </li>
          );
        })}
      </ol>
      <p className="pipeline__now" data-actor={stage.actor} data-escalated={escalated}>
        <strong>{escalated ? stage.label : `Stage ${step} of ${total}: ${stage.label}`}</strong>. {stage.doing}.{" "}
        {escalated ? "Waiting for a decision." : `Waiting on ${WHO[stage.actor]}.`}
      </p>
      {next && (
        <p className="pipeline__then">
          Next: <strong>{next.label}</strong>. {next.doing}.
        </p>
      )}
    </section>
  );
}
