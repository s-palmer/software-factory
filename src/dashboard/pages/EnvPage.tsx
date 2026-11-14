import { useCallback, useEffect, useState } from "react";
import type { EnvStatus } from "../../../shared/api";
import { api } from "../api";
import { EnvPanel } from "../components/EnvPanel";
import { usePolling } from "../usePolling";

/** `/env`: the local environment and the task that runs it. */
export function EnvPage() {
  const [status, setStatus] = useState<EnvStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    api.getEnv().then(
      (s) => {
        setStatus(s);
        setLoadError(null);
      },
      (err: unknown) => setLoadError(err instanceof Error ? err.message : String(err)),
    );
  }, []);
  useEffect(load, [load]);
  usePolling(load, true, 3000);

  async function act(action: () => Promise<{ ok: boolean; message: string }>) {
    setBusy(true);
    try {
      const r = await action();
      setMessage({ ok: r.ok, text: r.message });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
      load();
    }
  }

  if (loadError && !status) return <p role="alert" className="error">Couldn't load the local environment: {loadError}</p>;
  return <EnvPanel status={status} busy={busy} message={message} onStart={() => act(api.startEnv)} onStop={() => act(api.stopEnv)} />;
}
