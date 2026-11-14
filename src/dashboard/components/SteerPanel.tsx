import { useState } from "react";
import type { SteerInput, TaskContext } from "../../../shared/api";
import { AWAITING_HUMAN, type TaskStatus } from "../../../shared/lifecycle";
import { verifyAttrs } from "../../verify/core/contract";

export interface SteerPanelProps {
  status: TaskStatus;
  steering?: TaskContext["steering"];
  paused?: boolean;
  onSteer: (input: SteerInput) => Promise<void> | void;
  onPause: (paused: boolean) => Promise<void> | void;
  error?: string | null;
}

/**
 * Steer a running task: a note every later agent run reads, a stop that redoes the stage with the note, and pause.
 * A task that is done takes no notes.
 */
export function SteerPanel({ status, steering = [], paused = false, onSteer, onPause, error }: SteerPanelProps) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const done = status === "done";
  // Only a task the factory is working on has a run to stop.
  const running = !done && !AWAITING_HUMAN.has(status) && !paused;
  const hasNote = note.trim().length > 0;

  async function act(fn: () => Promise<void> | void, clear: boolean) {
    setBusy(true);
    try {
      await fn();
      if (clear) setNote("");
    } catch {
      // The parent shows the error through the `error` prop; keep the note.
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="steer" {...verifyAttrs({ unit: "SteerPanel", status, notes: steering.length, paused, done, "has-note": hasNote, busy })}>
      <h2>Steer</h2>
      {steering.length > 0 && (
        <ol className="steer__notes">
          {steering.map((s, i) => (
            <li key={i} title={s.at}>
              {s.note} <span className="steer__by">({s.by})</span>
            </li>
          ))}
        </ol>
      )}
      {done ? (
        <p className="hint">The task is done.</p>
      ) : (
        <>
          {paused && <p className="steer__paused">Paused: the factory takes no new steps on this task.</p>}
          <label htmlFor="steer-note">Note for the agents</label>
          <textarea id="steer-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Every later run on this task reads it." />
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <div className="steer__actions">
            <button type="button" className="steer-add" disabled={busy || !hasNote} onClick={() => act(() => onSteer({ note: note.trim(), restart: false }), true)}>
              Add note
            </button>
            <button type="button" className="steer-restart" disabled={busy || !hasNote || !running} onClick={() => act(() => onSteer({ note: note.trim(), restart: true }), true)}>
              Stop and redo the stage
            </button>
            <button type="button" className="steer-pause" disabled={busy} onClick={() => act(() => onPause(!paused), false)}>
              {paused ? "Resume" : "Pause"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
