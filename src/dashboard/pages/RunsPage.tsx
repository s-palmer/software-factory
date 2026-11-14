import { useCallback, useEffect, useState } from "react";
import type { TestRun } from "../../../shared/api";
import { api } from "../api";
import { RunTable } from "../components/RunTable";
import { usePolling } from "../usePolling";

export function RunsPage() {
  const [runs, setRuns] = useState<TestRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const load = useCallback(() => {
    api.listRuns().then(setRuns, (err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);
  useEffect(load, [load]);
  const running = runs?.some((r) => r.status === "running") ?? false;
  usePolling(load, running, 2000);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const run = await api.startRun();
      window.location.assign(`/runs/${encodeURIComponent(run.id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStarting(false);
    }
  }

  return (
    <div className="runs-page">
      <header className="page-header">
        <h1>Browser test runs</h1>
        <button type="button" className="primary" onClick={start} disabled={starting || running}>
          {running ? "A run is in progress…" : starting ? "Starting…" : "▶ Run browser tests"}
        </button>
      </header>
      <p className="hint">Runs the full Playwright suite in headless Chromium on the server, recording a video and trace of every test.</p>
      {error && <p role="alert" className="error">{error}</p>}
      {runs ? <RunTable runs={runs} /> : !error && <p>Loading…</p>}
    </div>
  );
}
