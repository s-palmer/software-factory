import type { CheckStatus, VerifyResult } from "../core/types";

const ICON: Record<CheckStatus, string> = { ok: "✅", fail: "❌", warn: "⚠️", probe: "🔍" };

export function Report({ result }: { result: VerifyResult }) {
  return (
    <div className="report" data-verdict={result.verdict}>
      <p className="report__verdict">
        <strong>{result.verdict}</strong> · {result.unitId} / {result.fixtureId} · {result.durationMs}ms
      </p>
      {result.blockedReason && <p className="report__blocked">{result.blockedReason}</p>}
      <ul>
        {result.checks.map((c, i) => (
          <li key={i}>
            {ICON[c.status]} <code>{c.verifier}</code> {c.label}
            {c.detail && <span className="report__detail"> ({c.detail})</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
