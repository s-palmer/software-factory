/**
 * mount → act → verify → verdict.
 *
 * - BLOCKED: no verifiers, or mounting / act steps threw (we couldn't observe).
 * - FAIL: any check failed. A verifier that throws becomes a failed check, never swallowed.
 * - PASS: otherwise (warn and probe don't fail the run).
 * - SKIP: the unit declares no fixtures.
 */
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { readContract } from "./contract";
import { verifiersFor } from "./registry";
import type { ActContext, AnyUnit, Check, Fixture, Verdict, VerifyResult } from "./types";

export interface Mounted {
  container: HTMLElement;
  unmount: () => void;
}

/** Let React flush effects and state updates scheduled by events. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export function makeActContext(root: HTMLElement): ActContext {
  return {
    root,
    async click(selector) {
      const el = root.querySelector<HTMLElement>(selector);
      if (!el) throw new Error(`act.click: no element matching "${selector}"`);
      el.click();
      await settle();
    },
    async type(selector, text) {
      const el = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
      if (!el) throw new Error(`act.type: no element matching "${selector}"`);
      // Use the native setter so React's onChange fires.
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
      setter?.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
    },
    async select(selector, value) {
      const el = root.querySelector<HTMLSelectElement>(selector);
      if (!el) throw new Error(`act.select: no element matching "${selector}"`);
      if (!Array.from(el.options).some((o) => o.value === value)) throw new Error(`act.select: "${selector}" has no option "${value}"`);
      el.value = value;
      // React listens to "change" on <select>.
      el.dispatchEvent(new Event("change", { bubbles: true }));
      await settle();
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** Mount a fixture into `container` and run its act steps. Throws if either fails. */
export async function mountFixture<P>(
  unit: AnyUnit,
  fixture: Fixture<P>,
  container: HTMLElement,
): Promise<Mounted> {
  const root = createRoot(container);
  const unmount = () => root.unmount();
  try {
    flushSync(() => root.render(unit.render(fixture.props)));
    await settle();
    if (fixture.act) await fixture.act(makeActContext(container));
    await settle();
  } catch (err) {
    unmount();
    throw err;
  }
  return { container, unmount };
}

/** Run every applicable verifier against an already-mounted fixture. */
export async function verifyMounted<P>(
  unit: AnyUnit,
  fixture: Fixture<P>,
  container: HTMLElement,
  started = performance.now(),
): Promise<VerifyResult> {
  const base = { unitId: unit.id, fixtureId: fixture.id, timestamp: new Date().toISOString() };
  const applicable = verifiersFor(unit);
  if (applicable.length === 0) {
    return blocked(base, started, `No verifiers registered for unit "${unit.id}".`);
  }

  const contract = readContract(container);
  const checks: Check[] = [];
  for (const v of applicable) {
    try {
      checks.push(
        ...(await v.run({ unit, fixture: fixture as Fixture<unknown>, root: container, contract })),
      );
    } catch (err) {
      checks.push({
        verifier: v.id,
        status: "fail",
        label: `Verifier "${v.id}" threw`,
        detail: String(err),
        evidence: err instanceof Error ? err.stack : err,
      });
    }
  }
  return { ...base, verdict: verdictOf(checks), checks, domSnapshot: contract, durationMs: since(started) };
}

/** Mount off-screen, verify, unmount. Used by CI (Vitest) and `window.__verify.runAll()`. */
export async function runFixture<P>(unit: AnyUnit, fixture: Fixture<P>): Promise<VerifyResult> {
  const started = performance.now();
  const container = document.createElement("div");
  container.setAttribute("data-verify-sandbox", "true");
  // Off-screen but in the document, so layout and a11y queries work.
  Object.assign(container.style, { position: "fixed", left: "-10000px", top: "0", width: "800px" });
  document.body.appendChild(container);

  let mounted: Mounted | undefined;
  try {
    mounted = await mountFixture(unit, fixture, container);
  } catch (err) {
    container.remove();
    return blocked(
      { unitId: unit.id, fixtureId: fixture.id, timestamp: new Date().toISOString() },
      started,
      `Mount or act failed: ${String(err)}`,
    );
  }
  try {
    return await verifyMounted(unit, fixture, container, started);
  } finally {
    mounted.unmount();
    container.remove();
  }
}

export async function runUnit(unit: AnyUnit): Promise<VerifyResult[]> {
  if (unit.fixtures.length === 0) {
    return [
      {
        unitId: unit.id,
        fixtureId: "(none)",
        verdict: "SKIP",
        checks: [],
        domSnapshot: {},
        durationMs: 0,
        blockedReason: "Unit declares no fixtures; nothing to observe.",
        timestamp: new Date().toISOString(),
      },
    ];
  }
  const out: VerifyResult[] = [];
  for (const f of unit.fixtures) out.push(await runFixture(unit, f));
  return out;
}

export function verdictOf(checks: Check[]): Verdict {
  return checks.some((c) => c.status === "fail") ? "FAIL" : "PASS";
}

function since(started: number): number {
  return Math.round(performance.now() - started);
}

function blocked(
  base: Pick<VerifyResult, "unitId" | "fixtureId" | "timestamp">,
  started: number,
  reason: string,
): VerifyResult {
  return { ...base, verdict: "BLOCKED", checks: [], domSnapshot: {}, durationMs: since(started), blockedReason: reason };
}
