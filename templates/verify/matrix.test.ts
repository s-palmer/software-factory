// @vitest-environment jsdom
/**
 * Every registered UI unit × fixture through every verifier, in jsdom. The same code runs in the browser
 * through the harness page ({{entry}}) and `window.__verify.runAll()`.
 */
import { describe, expect, it } from "vitest";
import "./verifiers";
import "./specs";
import { allUnits } from "./core/registry";
import { runFixture } from "./core/runner";

describe("verification matrix", () => {
  for (const unit of allUnits()) {
    describe(`unit ${unit.id}`, () => {
      it("has at least one probe fixture (an edge case)", () => {
        expect(unit.fixtures.some((f) => f.probe)).toBe(true);
      });
      for (const fixture of unit.fixtures) {
        it(`${fixture.probe ? "probe " : ""}${fixture.id} passes`, async () => {
          const r = await runFixture(unit, fixture);
          const failures = r.checks.filter((c) => c.status === "fail");
          expect(r.verdict, `${JSON.stringify(failures, null, 2)}\nblocked: ${r.blockedReason ?? "-"}`).toBe("PASS");
        });
      }
    });
  }
  it("loads", () => expect(true).toBe(true));
});
