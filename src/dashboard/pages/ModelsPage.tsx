import { useEffect, useState } from "react";
import type { DefaultModels } from "../../../shared/api";
import type { PhaseModels } from "../../../shared/models";
import { api } from "../api";
import { DefaultModelsEditor } from "../components/DefaultModelsEditor";

/** `/models`: the factory-wide default model of each pipeline step. */
export function ModelsPage() {
  const [defaults, setDefaults] = useState<DefaultModels | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  useEffect(() => {
    api.getDefaultModels().then(setDefaults, (err: unknown) => setLoadError(err instanceof Error ? err.message : String(err)));
  }, []);

  async function save(phaseModels: PhaseModels) {
    setSaveError(null);
    setSavedNote(null);
    try {
      setDefaults(await api.setDefaultModels({ phaseModels }));
      setSavedNote(`Saved ${Object.keys(phaseModels).length} step(s).`);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  if (loadError) return <p role="alert" className="error">Couldn't load the default models: {loadError}</p>;
  if (!defaults) return <p>Loading…</p>;
  return (
    <div className="models-page">
      <DefaultModelsEditor value={defaults.phaseModels} onSave={save} error={saveError} />
      {savedNote && <p role="status" className="models-page__saved">{savedNote}</p>}
    </div>
  );
}
