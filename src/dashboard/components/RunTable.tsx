import type { TestRun } from "../../../shared/api";
import { verifyAttrs } from "../../verify/core/contract";
import { formatFull, formatWhen } from "../time";

export interface RunTableProps {
  runs: TestRun[];
}

export function runCounts(run: TestRun): string {
  if (!run.summary) return run.status === "running" ? "…" : "-";
  const { passed, failed, flaky, skipped } = run.summary;
  return [`${passed} passed`, failed && `${failed} failed`, flaky && `${flaky} flaky`, skipped && `${skipped} skipped`].filter(Boolean).join(" · ");
}

export function RunTable({ runs }: RunTableProps) {
  const running = runs.filter((r) => r.status === "running").length;
  return (
    <section className="run-table" {...verifyAttrs({ unit: "RunTable", count: runs.length, running })}>
      {runs.length === 0 ? (
        <p className="empty">No test runs yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Run</th>
              <th scope="col">Status</th>
              <th scope="col">Tests</th>
              <th scope="col">Started</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} data-run-id={r.id}>
                <td>
                  <a href={`/runs/${encodeURIComponent(r.id)}`}>{r.id.slice(0, 8)}</a>
                  {r.taskId && <span className="run-table__task"> (task)</span>}
                </td>
                <td>
                  <span className="run-status" data-status={r.status}>{r.status}</span>
                </td>
                <td>{runCounts(r)}</td>
                <td>
                  <time dateTime={r.startedAt} title={formatFull(r.startedAt)}>{formatWhen(r.startedAt)}</time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
