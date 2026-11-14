/** The framework must catch lies, not just confirm truths. */
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import "../verifiers";
import { verifyAttrs } from "./contract";
import { registerUnit, registerVerifier, unregisterUnit } from "./registry";
import { runFixture, runUnit, verdictOf } from "./runner";
import type { VerifiableUnit } from "./types";

type Props = { count: number; claimed: number };

const Counter = ({ count, claimed }: Props) =>
  createElement("output", verifyAttrs({ unit: "Counter", count: claimed }), String(count));

function counterUnit(overrides: Partial<VerifiableUnit<Props>> = {}): VerifiableUnit<Props> {
  return registerUnit<Props>({
    id: "Counter",
    title: "Counter",
    description: "test unit",
    kind: "component",
    render: (p) => createElement(Counter, p),
    fixtures: [{ id: "honest", description: "", props: { count: 2, claimed: 2 } }],
    invariants: [
      {
        id: "contract-matches-text",
        description: "contract count equals rendered count",
        check: ({ root, contract }) => root.textContent === contract.count || `text=${root.textContent} contract=${contract.count}`,
      },
    ],
    ...overrides,
  });
}

afterEach(() => unregisterUnit("Counter"));

describe("runner", () => {
  it("passes an honest fixture", async () => {
    const unit = counterUnit();
    expect((await runFixture(unit, unit.fixtures[0]!)).verdict).toBe("PASS");
  });

  it("FAILs when the DOM contract lies about what is rendered", async () => {
    const unit = counterUnit();
    const r = await runFixture(unit, { id: "lying", description: "", props: { count: 2, claimed: 3 } });
    expect(r.verdict).toBe("FAIL");
    expect(r.checks.find((c) => c.status === "fail")?.detail).toBe("text=2 contract=3");
  });

  it("is BLOCKED (not FAIL) when an act step can't find its target", async () => {
    const unit = counterUnit();
    const r = await runFixture(unit, {
      id: "bad-act",
      description: "",
      props: { count: 1, claimed: 1 },
      act: (ctx) => ctx.click("#does-not-exist"),
    });
    expect(r.verdict).toBe("BLOCKED");
    expect(r.blockedReason).toContain("#does-not-exist");
  });

  it("is BLOCKED when none of the unit's verifiers exist", async () => {
    const unit = counterUnit({ verifiers: ["nope"] });
    expect((await runFixture(unit, unit.fixtures[0]!)).verdict).toBe("BLOCKED");
  });

  it("turns a throwing verifier into a failed check", async () => {
    registerVerifier({ id: "explodes", description: "", run: () => { throw new Error("boom"); } });
    const unit = counterUnit({ verifiers: ["explodes"] });
    const r = await runFixture(unit, unit.fixtures[0]!);
    expect(r.verdict).toBe("FAIL");
    expect(r.checks[0]?.detail).toContain("boom");
  });

  it("SKIPs a unit with no fixtures", async () => {
    const [r] = await runUnit(counterUnit({ fixtures: [] }));
    expect(r?.verdict).toBe("SKIP");
  });

  it("treats warn and probe as non-failing", () => {
    expect(verdictOf([{ verifier: "x", status: "warn", label: "" }, { verifier: "x", status: "probe", label: "" }])).toBe("PASS");
  });
});
