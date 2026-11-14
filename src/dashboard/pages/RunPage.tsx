import { useCallback, useEffect, useRef, useState } from "react";
import type { RunDetail } from "../../../shared/api";
import { api } from "../api";
import { RunResults } from "../components/RunResults";
import { runCounts } from "../components/RunTable";
import { usePolling } from "../usePolling";

export function RunPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  const load = useCallback(() => {
    api.getRun(id).then(setDetail, (err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [id]);
  useEffect(load, [load]);
  const running = detail?.run.status === "running";
  usePolling(load, running, 1000);

  // Keep the live log scrolled to the bottom while it grows.
  const liveLog = detail?.log;
  useEffect(() => {
    const el = logRef.current;
    if (running && el && liveLog !== undefined) el.scrollTop = el.scrollHeight;
  }, [liveLog, running]);

  if (error) return <p role="alert" className="error">{error}</p>;
  if (!detail) return <p>Loading…</p>;
  const { run, results, log } = detail;

  return (
    <article className="run-page">
      <a href="/runs">← All runs</a>
      <header className="page-header">
        <h1>Run {run.id.slice(0, 8)}</h1>
        <span className="run-status" data-status={run.status}>{run.status}</span>
      </header>
      <p>
        {runCounts(run)}
        {run.summary && ` · ${(run.summary.durationMs / 1000).toFixed(1)}s`}
        {run.taskId && (
          <>
            {" "}· for <a href={`/tasks/${encodeURIComponent(run.taskId)}`}>this task</a>
          </>
        )}
        {run.reportUrl && (
          <>
            {" "}· <a href={run.reportUrl} target="_blank" rel="noreferrer">Playwright report &amp; trace viewer</a>
          </>
        )}
      </p>
      {!running && <RunResults results={results} reportUrl={run.reportUrl} />}
      <details className="run-log" open={running || run.status === "error"}>
        <summary>Output{running && " (live)"}</summary>
        <pre ref={logRef}>{log || "(no output yet)"}</pre>
      </details>
    </article>
  );
}
