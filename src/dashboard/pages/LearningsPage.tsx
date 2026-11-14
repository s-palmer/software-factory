import { useCallback, useEffect, useState } from "react";
import type { Learning, UpdateLearningInput } from "../../../shared/api";
import { api } from "../api";
import { LearningList } from "../components/LearningList";
import { usePolling } from "../usePolling";

/** `/learnings`: the retro's proposals, and the ones already applied. */
export function LearningsPage() {
  const [learnings, setLearnings] = useState<Learning[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    api.listLearnings().then(setLearnings, (err: unknown) => setLoadError(err instanceof Error ? err.message : String(err)));
  }, []);
  useEffect(load, [load]);
  usePolling(load, !busy, 10_000);

  async function act(action: () => Promise<string>) {
    setBusy(true);
    try {
      setMessage({ ok: true, text: await action() });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
      load();
    }
  }

  const save = (id: string, change: UpdateLearningInput) =>
    act(async () => {
      const l = await api.updateLearning(id, change);
      return l.status === "approved" ? "Approved." : l.status === "rejected" ? "Rejected." : "Saved.";
    });
  const apply = () =>
    act(async () => {
      const r = await api.applyLearnings();
      return `${r.factory} added to the learnings file; ${r.tasks.length} task(s) created.`;
    });

  if (loadError && !learnings) return <p role="alert" className="error">Couldn't load the learnings: {loadError}</p>;
  if (!learnings) return <p>Loading…</p>;
  return <LearningList learnings={learnings} onSave={save} onApply={apply} busy={busy} message={message} />;
}
