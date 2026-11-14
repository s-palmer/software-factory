import { useState, type FormEvent } from "react";
import { PHASES, PHASE_INFO, type Phase, type PhaseModels } from "../../../shared/models";
import { verifyAttrs } from "../../verify/core/contract";
import { modelOptions } from "./ModelPicker";

export interface DefaultModelsEditorProps {
  /** The saved factory defaults, every phase filled. */
  value: Record<Phase, string>;
  /** Called with only the phases that changed. */
  onSave: (phaseModels: PhaseModels) => Promise<void> | void;
  error?: string | null;
}

/** The factory-wide default model of each pipeline step. Tasks without an override use these. */
export function DefaultModelsEditor({ value, onSave, error }: DefaultModelsEditorProps) {
  const [draft, setDraft] = useState<Record<Phase, string>>(value);
  const [saving, setSaving] = useState(false);

  // Follow the saved value when it changes (e.g. after a save), React's "adjust state during render" pattern.
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setDraft(value);
  }

  const changed = PHASES.filter((p) => draft[p] !== value[p]);
  const canSave = changed.length > 0 && !saving;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    try {
      await onSave(Object.fromEntries(changed.map((p) => [p, draft[p]])));
    } catch {
      // Parent surfaces the error via the `error` prop; keep the draft.
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="default-models" onSubmit={save} {...verifyAttrs({ unit: "DefaultModelsEditor", changed: changed.length, saving, "can-save": canSave })}>
      <h2>Default models</h2>
      <p className="hint">Each pipeline step runs as its own agent. A task uses these unless it overrides a step.</p>
      <table className="models__plan">
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col">Model</th>
          </tr>
        </thead>
        <tbody>
          {PHASES.map((p) => (
            <tr key={p} data-phase={p} data-role={PHASE_INFO[p].role} data-changed={draft[p] !== value[p]}>
              <td>
                <label htmlFor={`default-model-${p}`} className="models__label">
                  {PHASE_INFO[p].label}
                </label>
                <span className="models__role">{PHASE_INFO[p].role}</span>
              </td>
              <td>
                <select id={`default-model-${p}`} value={draft[p]} onChange={(e) => setDraft((d) => ({ ...d, [p]: e.target.value }))}>
                  {[...new Set([...modelOptions(value[p]), ...modelOptions(draft[p])])].map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="default-models__actions">
        <button type="submit" className="primary" disabled={!canSave}>
          {saving ? "Saving…" : "Save defaults"}
        </button>
        <button type="button" disabled={changed.length === 0 || saving} onClick={() => setDraft(value)}>
          Undo changes
        </button>
      </div>
    </form>
  );
}
