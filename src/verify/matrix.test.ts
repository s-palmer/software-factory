/**
 * CI path: every registered unit × fixture through every applicable verifier.
 * Same runFixture() code path as `window.__verify.runAll()` and the /verify dashboard.
 */
import { describe, expect, it } from "vitest";
import "./verifiers";
import "./specs";
import { allUnits } from "./core/registry";
import { runFixture } from "./core/runner";

describe("verification matrix", () => {
  const units = allUnits();

  it("has units registered", () => {
    expect(units.length).toBeGreaterThan(0);
  });

  for (const unit of units) {
    describe(`unit ${unit.id}`, () => {
      it("has at least one probe fixture (not just the happy path)", () => {
        expect(unit.fixtures.some((f) => f.probe)).toBe(true);
      });

      for (const fixture of unit.fixtures) {
        it(`${fixture.probe ? "🔍 " : ""}${fixture.id} → PASS`, async () => {
          const r = await runFixture(unit, fixture);
          const failures = r.checks.filter((c) => c.status === "fail");
          expect(r.verdict, `${JSON.stringify(failures, null, 2)}\nblocked: ${r.blockedReason ?? "-"}`).toBe("PASS");
        });
      }
    });
  }
});
