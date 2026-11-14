import type { TaskSummary } from "../../../shared/api";
import { verifyAttrs } from "../../verify/core/contract";

export type TaskRef = Pick<TaskSummary, "id" | "ticketKey" | "status">;

export interface WaitingForProps {
  /** Ids of the tasks this one is blocked by. */
  blockedBy: string[];
  /** Known tasks, to turn ids into ticket keys. */
  tasks: TaskRef[];
}

/** The blockers that aren't done yet, as ticket keys (a short id when the task has no key or isn't known). */
export function pendingBlockers(blockedBy: string[], tasks: TaskRef[]): Array<{ id: string; label: string }> {
  return blockedBy.flatMap((id) => {
    const t = tasks.find((x) => x.id === id);
    if (t?.status === "done") return [];
    return [{ id, label: t?.ticketKey ?? id.slice(0, 8) }];
  });
}

/** "waiting for #5, #6": the unfinished tasks this one is blocked by. Renders hidden when there are none. */
export function WaitingFor({ blockedBy, tasks }: WaitingForProps) {
  const pending = pendingBlockers(blockedBy, tasks);
  return (
    <span className="waiting-for" hidden={pending.length === 0} {...verifyAttrs({ unit: "WaitingFor", count: pending.length, blockers: pending.map((p) => p.label).join(" ") })}>
      waiting for{" "}
      {pending.map((p, i) => (
        <span key={p.id}>
          {i > 0 && ", "}
          <a href={`/tasks/${encodeURIComponent(p.id)}`} data-blocker-id={p.id}>
            {p.label}
          </a>
        </span>
      ))}
    </span>
  );
}
