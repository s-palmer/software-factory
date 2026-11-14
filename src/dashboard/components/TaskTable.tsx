import type { TaskSummary } from "../../../shared/api";
import { AWAITING_HUMAN } from "../../../shared/lifecycle";
import { verifyAttrs } from "../../verify/core/contract";
import { PipelineProgress } from "./PipelineProgress";
import { StatusBadge } from "./StatusBadge";
import { WaitingFor, pendingBlockers } from "./WaitingFor";

export interface TaskTableProps {
  tasks: TaskSummary[];
}

export const formatCost = (usd: number) => `$${usd.toFixed(2)}`;

export function TaskTable({ tasks }: TaskTableProps) {
  const awaiting = tasks.filter((t) => AWAITING_HUMAN.has(t.status)).length;
  const cost = tasks.reduce((sum, t) => sum + t.costUsd, 0);
  const waiting = tasks.filter((t) => !t.ready && pendingBlockers(t.blockedBy, tasks).length > 0).length;
  return (
    <section className="task-table" {...verifyAttrs({ unit: "TaskTable", count: tasks.length, awaiting, waiting, cost: cost.toFixed(2) })}>
      {tasks.length === 0 ? (
        <p className="empty">No tasks yet. Add one above.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Ticket</th>
              <th scope="col">Task</th>
              <th scope="col">Status</th>
              <th scope="col">Progress</th>
              <th scope="col">Attempts</th>
              <th scope="col">Cost</th>
              <th scope="col">Screenshots</th>
              <th scope="col">Updated</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id} data-task-id={t.id} data-awaiting={AWAITING_HUMAN.has(t.status)}>
                <td className="task-table__ticket">{t.ticketKey ?? ""}</td>
                <td className="task-table__title">
                  <a href={`/tasks/${encodeURIComponent(t.id)}`}>{t.title}</a>
                  {AWAITING_HUMAN.has(t.status) && <span className="needs-you">Needs you</span>}
                  {!t.ready && t.blockedBy.length > 0 && <WaitingFor blockedBy={t.blockedBy} tasks={tasks} />}
                </td>
                <td>
                  <StatusBadge status={t.status} />
                </td>
                <td>
                  <PipelineProgress status={t.status} compact />
                </td>
                <td className="task-table__attempts">{t.attempts}</td>
                <td className="task-table__cost">{formatCost(t.costUsd)}</td>
                <td>{t.screenshotCount}</td>
                <td>
                  <time dateTime={t.updatedAt}>{t.updatedAt.replace("T", " ")}</time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
