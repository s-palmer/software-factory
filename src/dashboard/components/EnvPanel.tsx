import type { EnvStatus } from "../../../shared/api";
import { verifyAttrs } from "../../verify/core/contract";

export interface EnvPanelProps {
  /** null while loading. */
  status: EnvStatus | null;
  onStart: () => void;
  onStop: () => void;
  busy?: boolean;
  /** The result of the last start or stop. */
  message?: { ok: boolean; text: string } | null;
}

export type EnvState = "loading" | "task" | "person" | "external" | "free";

export function envState(status: EnvStatus | null): EnvState {
  if (!status) return "loading";
  if (status.lease) return status.lease.holder;
  return status.external ? "external" : "free";
}

/** The local environment the browser check uses: whether it is up, which task (or person) holds it, who waits, its log. */
export function EnvPanel({ status, onStart, onStop, busy = false, message }: EnvPanelProps) {
  const state = envState(status);
  const lease = status?.lease ?? null;
  const canStart = state === "free" && Boolean(status?.configured) && !busy;
  const canStop = state === "person" && !busy;
  return (
    <section className="env" {...verifyAttrs({ unit: "EnvPanel", state, up: status?.up ?? false, waiting: status?.waiting.length ?? 0, "can-start": canStart, "can-stop": canStop })}>
      <header className="env__head">
        <h2>Local environment</h2>
        <span className="env__up" data-up={status?.up ?? false}>
          {status === null ? "loading" : status.up ? "up" : "down"}
        </span>
      </header>
      {status && (
        <>
          <p className="env__holder" data-state={state}>
            {state === "task" && lease && (
              <>
                Running for task{" "}
                <a href={`/tasks/${encodeURIComponent(lease.taskId ?? "")}`}>{lease.ticketKey ? `${lease.ticketKey} ${lease.title ?? ""}` : (lease.title ?? lease.taskId)}</a>
                {lease.status ? ` (${lease.status.replace(/_/g, " ")})` : ""}, since {lease.acquiredAt.slice(0, 19)}
                {lease.pid !== null ? `, pid ${lease.pid}` : ""}
                {!lease.running && lease.pid !== null ? ". The process has exited" : ""}
              </>
            )}
            {state === "person" && lease && (
              <>
                Started by a person from the repository checkout, since {lease.acquiredAt.slice(0, 19)}
                {lease.pid !== null ? `, pid ${lease.pid}` : ""}
                {!lease.running ? ". The process has exited" : ""}
              </>
            )}
            {state === "external" && (
              <>
                Running outside the factory. Browser checks wait until it stops.
                {status.portHolders.length > 0 && (
                  <span className="env__ports"> {status.portHolders.map((p) => `${p.command} (pid ${p.pid}) on port ${p.port}`).join(", ")}</span>
                )}
              </>
            )}
            {state === "free" && "Free. A task's browser check starts it when needed."}
          </p>
          <dl className="env__config">
            <dt>Start command</dt>
            <dd>{status.command ? <code>{status.command}</code> : "None. Set app.start in factory.config.json, or browser checks escalate."}</dd>
            <dt>URL</dt>
            <dd>
              <a href={status.url}>{status.url}</a>
            </dd>
          </dl>
          {status.waiting.length > 0 && (
            <div className="env__waiting">
              <h3>Waiting ({status.waiting.length})</h3>
              <ul>
                {status.waiting.map((w) => (
                  <li key={w.taskId} data-task-id={w.taskId}>
                    <a href={`/tasks/${encodeURIComponent(w.taskId)}`}>{w.ticketKey ? `${w.ticketKey} ${w.title}` : w.title}</a>: {w.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="env__actions">
            <button type="button" className="env__start" disabled={!canStart} onClick={onStart}>
              Start from the checkout
            </button>
            <button type="button" className="env__stop" disabled={!canStop} onClick={onStop}>
              Stop
            </button>
          </div>
          {message && (
            <p role={message.ok ? "status" : "alert"} className={message.ok ? "env__message" : "env__message error"}>
              {message.text}
            </p>
          )}
          {status.log && <pre className="env__log">{status.log}</pre>}
        </>
      )}
    </section>
  );
}
