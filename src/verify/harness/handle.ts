/**
 * `window.__verify`: the agent-facing handle. An agent or Playwright can discover every
 * unit × fixture via manifest(), open its route, and read current() for a structured result.
 */
import { allUnits, buildManifest } from "../core/registry";
import { runUnit } from "../core/runner";
import type { VerifyHandle, VerifyResult } from "../core/types";

let currentResult: VerifyResult | null = null;

export function setCurrentResult(result: VerifyResult | null): void {
  currentResult = result;
  // Mirrors for consumers that can only read the DOM.
  if (result) document.body.dataset.verifyVerdict = result.verdict;
  else delete document.body.dataset.verifyVerdict;
}

export function installVerifyHandle(): VerifyHandle {
  const handle: VerifyHandle = {
    version: "1.0",
    manifest: buildManifest,
    current: () => currentResult,
    runAll: async () => (await Promise.all(allUnits().map(runUnit))).flat(),
  };
  window.__verify = handle;
  return handle;
}
