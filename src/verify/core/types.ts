/**
 * Core types for runtime verification.
 *
 * Adapted from Anthropic's "How We Claude Code" workshop (phase-3-verify, Apache-2.0):
 * https://github.com/anthropics/cwc-workshops/tree/main/how-we-claude-code
 *
 * - Verification is runtime observation of the rendered DOM.
 * - Verdicts: PASS | FAIL | BLOCKED | SKIP. BLOCKED ("couldn't observe") is not FAIL ("observed and wrong").
 * - Every unit declares fixtures; `probe: true` marks an off-happy-path fixture.
 * - Verifiers are pluggable and independent of components.
 */
import type { ReactElement } from "react";
import type { ZodType } from "zod";

export type Verdict = "PASS" | "FAIL" | "BLOCKED" | "SKIP";

/** ok = confirmed · fail = observed and wrong · warn = concerning · probe = edge case that held */
export type CheckStatus = "ok" | "fail" | "warn" | "probe";

export interface Check {
  verifier: string;
  status: CheckStatus;
  label: string;
  detail?: string;
  evidence?: unknown;
}

export interface VerifyResult {
  unitId: string;
  fixtureId: string;
  verdict: Verdict;
  checks: Check[];
  /** `data-verify-*` attributes of the unit's root at time of verification. */
  domSnapshot: Record<string, string>;
  durationMs: number;
  blockedReason?: string;
  timestamp: string;
}

export interface ActContext {
  root: HTMLElement;
  click: (selector: string) => Promise<void>;
  type: (selector: string, text: string) => Promise<void>;
  /** Choose an option of a <select> by value. */
  select: (selector: string, value: string) => Promise<void>;
  wait: (ms: number) => Promise<void>;
}

export interface Fixture<P> {
  id: string;
  description: string;
  props: P;
  /** Off-happy-path / adversarial case. Every unit must have at least one. */
  probe?: boolean;
  /** Steps to run after mount and before verification ("render, click X, then verify"). */
  act?: (ctx: ActContext) => Promise<void>;
}

export interface InvariantContext<P> {
  root: HTMLElement;
  props: P;
  fixture: Fixture<P>;
  contract: Record<string, string>;
}

export interface Invariant<P> {
  id: string;
  description: string;
  /** true = holds; false or a string (explanation) = violated. */
  check: (ctx: InvariantContext<P>) => boolean | string;
  onlyFixtures?: string[];
}

export interface VerifiableUnit<P> {
  id: string;
  title: string;
  description: string;
  kind: "component" | "feature";
  render: (props: P) => ReactElement;
  propsSchema?: ZodType;
  fixtures: Fixture<P>[];
  invariants: Invariant<P>[];
  /** Verifier ids to run. Omit to run all registered verifiers. */
  verifiers?: string[];
}

/** Type-erased unit, as stored in the registry. */
// oxlint-disable-next-line typescript/no-explicit-any -- registry holds units with heterogeneous props
export type AnyUnit = VerifiableUnit<any>;

export interface VerifierContext {
  unit: AnyUnit;
  fixture: Fixture<unknown>;
  root: HTMLElement;
  contract: Record<string, string>;
}

export interface Verifier {
  id: string;
  description: string;
  run: (ctx: VerifierContext) => Check[] | Promise<Check[]>;
}

export interface VerifyManifestEntry {
  unitId: string;
  title: string;
  kind: "component" | "feature";
  fixtures: Array<{ id: string; description: string; probe: boolean; route: string }>;
  verifiers: string[];
  invariants: Array<{ id: string; description: string }>;
}

/** The agent-facing handle, exposed as `window.__verify`. */
export interface VerifyHandle {
  version: string;
  manifest: () => VerifyManifestEntry[];
  /** Result for the unit/fixture mounted on the current `/verify/:unit/:fixture` page. */
  current: () => VerifyResult | null;
  runAll: () => Promise<VerifyResult[]>;
}

declare global {
  interface Window {
    __verify?: VerifyHandle;
  }
}
