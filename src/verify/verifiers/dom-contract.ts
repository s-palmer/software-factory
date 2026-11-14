/** The unit must emit a `data-verify-*` contract that names itself. */
import { readAllContracts } from "../core/contract";
import { registerVerifier } from "../core/registry";
import type { Check } from "../core/types";

export const domContractVerifier = registerVerifier({
  id: "dom-contract",
  description: "The unit emits a machine-readable data-verify-* contract.",
  run({ unit, fixture, root, contract }) {
    if (Object.keys(contract).length === 0) {
      return [{ verifier: "dom-contract", status: "fail", label: "No DOM contract emitted" }];
    }
    const checks: Check[] = [
      {
        verifier: "dom-contract",
        status: fixture.probe ? "probe" : "ok",
        label: `Contract present (${Object.keys(contract).length} attrs)`,
        evidence: contract,
      },
    ];
    if (contract.unit !== unit.id) {
      checks.push({
        verifier: "dom-contract",
        status: "fail",
        label: "Contract does not identify this unit",
        detail: `expected data-verify-unit="${unit.id}", got "${contract.unit ?? ""}"`,
      });
    }
    if (unit.kind === "component" && readAllContracts(root, unit.id).length > 1) {
      checks.push({ verifier: "dom-contract", status: "warn", label: "Component emitted more than one root contract" });
    }
    return checks;
  },
});
