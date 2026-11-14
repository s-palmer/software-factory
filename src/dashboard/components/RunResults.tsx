import type { TestResult } from "../../../shared/api";
import { verifyAttrs } from "../../verify/core/contract";

export interface RunResultsProps {
  results: TestResult[];
  /** Link to the Playwright HTML report (trace viewer), if any. */
  reportUrl?: string | null;
}

const ICON: Record<TestResult["status"], string> = { passed: "✓", failed: "✕", flaky: "!", skipped: "–" };

/** Per-test outcome with the session's video, screenshots and trace. */
export function RunResults({ results, reportUrl = null }: RunResultsProps) {
  const failed = results.filter((r) => r.status === "failed").length;
  const videos = results.reduce((n, r) => n + r.attachments.filter((a) => a.kind === "video").length, 0);
  // Failures first: that's what a reviewer needs to look at.
  const ordered = [...results].sort((a, b) => Number(b.status === "failed") - Number(a.status === "failed"));

  return (
    <section className="run-results" {...verifyAttrs({ unit: "RunResults", count: results.length, failed, videos })}>
      <h2>Tests ({results.length})</h2>
      {results.length === 0 ? (
        <p className="empty">No test results.</p>
      ) : (
        <ul>
          {ordered.map((r, i) => {
            const shots = r.attachments.filter((a) => a.kind === "screenshot");
            const video = r.attachments.find((a) => a.kind === "video");
            const trace = r.attachments.find((a) => a.kind === "trace");
            return (
              <li key={`${r.file}:${r.title}:${i}`} className="run-result" data-status={r.status}>
                <h3>
                  <span className="run-result__icon" aria-hidden="true">{ICON[r.status]}</span> {r.title}{" "}
                  <small>
                    {r.status} · {(r.durationMs / 1000).toFixed(1)}s · {r.file}
                  </small>
                </h3>
                {r.error && <pre className="run-result__error">{r.error}</pre>}
                <div className="run-result__media">
                  {video && (
                    <video controls preload="metadata" src={video.url} aria-label={`Recording of ${r.title}`}>
                      <a href={video.url}>Download video</a>
                    </video>
                  )}
                  {shots.map((s) => (
                    <a key={s.path} href={s.url} target="_blank" rel="noreferrer">
                      <img src={s.url} alt={`${r.title}: ${s.name}`} loading="lazy" />
                    </a>
                  ))}
                </div>
                {trace && (
                  <p className="run-result__trace">
                    Trace: <a href={trace.url}>download</a>
                    {reportUrl && (
                      <>
                        {" "}or <a href={reportUrl} target="_blank" rel="noreferrer">open in the report's trace viewer</a>
                      </>
                    )}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
