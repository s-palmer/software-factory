import { useState } from "react";
import { buildManifest } from "../core/registry";
import type { VerifyResult } from "../core/types";

/** `/verify`: a human view of the same data agents get from `window.__verify`. */
export function Dashboard() {
  const manifest = buildManifest();
  const [results, setResults] = useState<Map<string, VerifyResult>>(new Map());
  const [running, setRunning] = useState(false);

  async function runAll() {
    setRunning(true);
    const all = (await window.__verify?.runAll()) ?? [];
    setResults(new Map(all.map((r) => [`${r.unitId}::${r.fixtureId}`, r])));
    setRunning(false);
  }

  return (
    <main className="dashboard">
      <h1>Verification</h1>
      <button type="button" onClick={runAll} disabled={running}>
        {running ? "Running…" : "Run all"}
      </button>
      {manifest.map((unit) => (
        <section key={unit.unitId}>
          <h2>
            {unit.title} <small>({unit.kind})</small>
          </h2>
          <ul>
            {unit.fixtures.map((f) => {
              const r = results.get(`${unit.unitId}::${f.id}`);
              return (
                <li key={f.id}>
                  {f.probe && "🔍 "}
                  <a href={f.route}>{f.id}</a> {f.description} {r && <strong data-verdict={r.verdict}>{r.verdict}</strong>}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </main>
  );
}
