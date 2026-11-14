import { KNOWN_MODELS, PHASES, PHASE_INFO, modelFor, type Phase, type PhaseModels } from "../../../shared/models";
import { verifyAttrs } from "../../verify/core/contract";

export interface ModelChange {
  phase: Phase;
  /** null clears the override, so the phase falls back to the factory default. */
  model: string | null;
}

export interface ModelPickerProps {
  /** The factory defaults (GET /api/models). */
  defaults: PhaseModels;
  /** The task's per-phase overrides. */
  overrides?: PhaseModels;
  onChange: (change: ModelChange) => void;
  disabled?: boolean;
  /** Prefix for the select ids; must be unique on the page. */
  idPrefix?: string;
}

/** Options for a phase select: the known models, plus the current one if it isn't known. */
export const modelOptions = (current: string | undefined): string[] => (current && !KNOWN_MODELS.includes(current) ? [...KNOWN_MODELS, current] : [...KNOWN_MODELS]);

/** Each pipeline step is its own agent: pick its model for this task, or leave it on the factory default. */
export function ModelPicker({ defaults, overrides = {}, onChange, disabled = false, idPrefix = "phase-model" }: ModelPickerProps) {
  const overridden = PHASES.filter((p) => overrides[p] !== undefined);
  return (
    <fieldset className="models" disabled={disabled} {...verifyAttrs({ unit: "ModelPicker", overridden: overridden.length, phases: PHASES.length })}>
      <legend>Models</legend>
      <p className="models__summary">Each step runs as its own agent. Override a step for this task, or keep the factory default.</p>
      <table className="models__plan">
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col">Model</th>
          </tr>
        </thead>
        <tbody>
          {PHASES.map((p) => {
            const override = overrides[p];
            const id = `${idPrefix}-${p}`;
            return (
              <tr key={p} data-phase={p} data-role={PHASE_INFO[p].role} data-overridden={override !== undefined} data-model={modelFor(p, defaults, overrides)}>
                <td>
                  <label htmlFor={id} className="models__label">
                    {PHASE_INFO[p].label}
                  </label>
                  <span className="models__role">{PHASE_INFO[p].role}</span>
                </td>
                <td>
                  <select id={id} value={override ?? ""} onChange={(e) => onChange({ phase: p, model: e.target.value === "" ? null : e.target.value })}>
                    <option value="">Default ({modelFor(p, defaults)})</option>
                    {modelOptions(override).map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  {override !== undefined && <span className="models__override">override</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </fieldset>
  );
}
