/** Runs each invariant the unit declares against the mounted DOM. */
import { registerVerifier } from "../core/registry";
import type { Check } from "../core/types";

export const invariantVerifier = registerVerifier({
  id: "invariants",
  description: "The unit's declared invariants hold on the mounted DOM.",
  run({ unit, fixture, root, contract }) {
    const checks: Check[] = [];
    for (const inv of unit.invariants) {
      if (inv.onlyFixtures && !inv.onlyFixtures.includes(fixture.id)) continue;
      let outcome: boolean | string;
      try {
        outcome = inv.check({ root, props: fixture.props, fixture, contract });
      } catch (err) {
        checks.push({ verifier: "invariants", status: "fail", label: inv.description, detail: `"${inv.id}" threw: ${String(err)}` });
        continue;
      }
      checks.push(
        outcome === true
          ? { verifier: "invariants", status: fixture.probe ? "probe" : "ok", label: inv.description }
          : {
              verifier: "invariants",
              status: "fail",
              label: inv.description,
              detail: typeof outcome === "string" ? outcome : `"${inv.id}" returned false`,
            },
      );
    }
    if (checks.length === 0) {
      checks.push({ verifier: "invariants", status: "warn", label: "No invariants ran for this fixture" });
    }
    return checks;
  },
});
