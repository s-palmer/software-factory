/** Validates fixture props against the unit's zod schema. */
import { registerVerifier } from "../core/registry";

export const schemaVerifier = registerVerifier({
  id: "schema",
  description: "Fixture props match the unit's propsSchema.",
  run({ unit, fixture }) {
    if (!unit.propsSchema) {
      return [{ verifier: "schema", status: "warn", label: "No propsSchema declared" }];
    }
    const result = unit.propsSchema.safeParse(fixture.props);
    if (result.success) {
      return [{ verifier: "schema", status: fixture.probe ? "probe" : "ok", label: "Props match schema" }];
    }
    return [
      {
        verifier: "schema",
        status: "fail",
        label: "Props violate schema",
        detail: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        evidence: result.error.issues,
      },
    ];
  },
});
