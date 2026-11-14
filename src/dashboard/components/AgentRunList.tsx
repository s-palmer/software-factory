import type { AgentRun } from "../../../shared/api";
import { statusLabel } from "../../../shared/lifecycle";
import { verifyAttrs } from "../../verify/core/contract";
import { formatFull, formatWhen } from "../time";

export interface AgentRunListProps {
  runs: AgentRun[];
}

/**
 * Newest first. Start times have second precision, so among runs started the same second the running one goes
 * first: a task runs one thing at a time, so a run still going is the latest. Otherwise the API's order is kept.
 */
export const newestFirst = (a: AgentRun, b: AgentRun) =>
  b.startedAt.localeCompare(a.startedAt) || Number(b.status === "running") - Number(a.status === "running");

/** Every agent run and factory check on a task, newest first. */
export function AgentRunList({ runs }: AgentRunListProps) {
  const sorted = [...runs].sort(newestFirst);
  const cost = runs.reduce((n, r) => n + r.costUsd, 0);
  const running = runs.filter((r) => r.status === "running").length;
  return (
    <section className="agent-runs" {...verifyAttrs({ unit: "AgentRunList", count: runs.length, running, cost: cost.toFixed(2) })}>
      <h2>Agent runs</h2>
      {sorted.length === 0 ? (
        <p className="empty">No agent runs yet.</p>
      ) : (
        <ol className="agent-runs__list">
          {sorted.map((r) => (
            <li key={r.id} className="agent-run" data-run-id={r.id} data-status={r.status} data-started={r.startedAt}>
              <div className="agent-run__head">
                <span className="agent-run__stage">{statusLabel(r.stage)}</span>
                <span className="agent-run__kind">{r.kind}</span>
                <span className="agent-run__status" data-status={r.status}>
                  {r.status}
                </span>
              </div>
              <dl className="agent-run__facts">
                <dt>Model</dt>
                <dd className="agent-run__model">{r.model ?? "none"}</dd>
                <dt>Cost</dt>
                <dd className="agent-run__cost">${r.costUsd.toFixed(2)}</dd>
                <dt>Turns</dt>
                <dd className="agent-run__turns">{r.turns}</dd>
                <dt>Started</dt>
                <dd>
                  <time dateTime={r.startedAt} title={formatFull(r.startedAt)}>{formatWhen(r.startedAt)}</time>
                </dd>
              </dl>
              {r.summary && <p className="agent-run__summary">{r.summary}</p>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
