import { useEffect, useRef, useState } from "react";
import { getUnit } from "../core/registry";
import { mountFixture, verifyMounted } from "../core/runner";
import type { VerifyResult } from "../core/types";
import { setCurrentResult } from "./handle";
import { Report } from "./Report";

/** `/verify/:unit/:fixture` mounts one unit in a known state. `?chrome=0` hides the report for clean screenshots. */
export function UnitPage({ unitId, fixtureId }: { unitId: string; fixtureId: string }) {
  const stage = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chrome = new URLSearchParams(window.location.search).get("chrome") !== "0";

  const unit = getUnit(unitId);
  const fixture = unit?.fixtures.find((f) => f.id === fixtureId);

  useEffect(() => {
    const container = stage.current;
    if (!unit || !fixture || !container) return;
    const run: { cancelled: boolean; unmount?: () => void } = { cancelled: false };
    const started = performance.now();
    setCurrentResult(null);

    mountFixture(unit, fixture, container)
      .then(async (m) => {
        run.unmount = m.unmount;
        if (run.cancelled) return m.unmount();
        const r = await verifyMounted(unit, fixture, container, started);
        if (run.cancelled) return;
        setResult(r);
        setCurrentResult(r);
      })
      .catch((err: unknown) => {
        if (run.cancelled) return;
        const r: VerifyResult = {
          unitId,
          fixtureId,
          verdict: "BLOCKED",
          checks: [],
          domSnapshot: {},
          durationMs: Math.round(performance.now() - started),
          blockedReason: `Mount or act failed: ${String(err)}`,
          timestamp: new Date().toISOString(),
        };
        setError(r.blockedReason ?? null);
        setResult(r);
        setCurrentResult(r);
      });

    return () => {
      run.cancelled = true;
      run.unmount?.();
    };
  }, [unit, fixture, unitId, fixtureId]);

  if (!unit || !fixture) {
    return <p role="alert">Unknown unit or fixture: {unitId} / {fixtureId}</p>;
  }

  return (
    <main className="unit-page">
      {chrome && (
        <header>
          <a href="/verify">← all units</a>
          <h1>
            {unit.title} / {fixture.id} {fixture.probe && "🔍"}
          </h1>
          <p>{fixture.description}</p>
        </header>
      )}
      <div ref={stage} className="unit-page__stage" data-verify-stage />
      {chrome && result && <Report result={result} />}
      {chrome && error && <p role="alert">{error}</p>}
    </main>
  );
}
