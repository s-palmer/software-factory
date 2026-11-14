import { AWAITING_HUMAN, statusLabel, type TaskStatus } from "../../../shared/lifecycle";

export function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className="status-badge" data-status={status} data-awaiting={AWAITING_HUMAN.has(status)}>
      {statusLabel(status)}
    </span>
  );
}
