import type { OrchestratorState } from "../api";
import { verifyAttrs } from "../../verify/core/contract";

export interface OrchestratorSwitchProps {
  /** null while loading. */
  state: OrchestratorState | null;
  onToggle: (running: boolean) => void;
  busy?: boolean;
  error?: string | null;
}

/** Turns the orchestrator loop on or off. */
export function OrchestratorSwitch({ state, onToggle, busy = false, error }: OrchestratorSwitchProps) {
  const available = state?.available ?? false;
  const running = available && (state?.running ?? false);
  const label = state === null ? "loading" : !available ? "not available" : running ? "on" : "off";
  return (
    <section className="orchestrator" {...verifyAttrs({ unit: "OrchestratorSwitch", available, running, loading: state === null, busy })}>
      <label className="orchestrator__switch">
        <input type="checkbox" role="switch" checked={running} disabled={!available || busy} onChange={(e) => onToggle(e.target.checked)} />
        <span>Orchestrator loop</span>
      </label>
      <span className="orchestrator__state" data-state={label}>
        {label}
      </span>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
