import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyRisk, matchesGlob, RiskPolicy, type FileChange } from "./risk";

const policy = RiskPolicy.parse(JSON.parse(readFileSync("factory.config.json", "utf8")).policy);
const mod = (path: string, lines = 10): FileChange => ({ path, status: "modified", added: lines, removed: 0 });

describe("matchesGlob", () => {
  it.each([
    ["src/auth/login.ts", "**/auth/**", true],
    ["auth/x.ts", "**/auth/**", true],
    ["src/author.ts", "**/auth/**", false],
    ["e2e/a/b.spec.ts", "e2e/**", true],
    ["server/app.test.ts", "**/*.test.ts", true],
    ["server/app.ts", "**/*.test.ts", false],
    ["apps/web/.env.local", "**/.env*", true],
    ["package.json", "package.json", true],
    ["apps/package.json", "package.json", false],
    ["./package.json", "package.json", true],
    ["a.b", "a?b", true],
    ["a/b", "a?b", false],
  ])("%s vs %s → %s", (path, glob, expected) => {
    expect(matchesGlob(path, glob)).toBe(expected);
  });
});

describe("classifyRisk with the project policy", () => {
  it("is low for a small UI change", () => {
    expect(classifyRisk([mod("src/dashboard/components/TaskTable.tsx"), mod("src/styles.css")], policy)).toEqual({ level: "low", reasons: [] });
  });

  it("is high when the change touches what judges it", () => {
    const r = classifyRisk([mod("src/dashboard/components/TaskTable.tsx"), mod("src/verify/specs/TaskTable.verify.ts")], policy);
    expect(r.level).toBe("high");
    expect(r.reasons).toEqual(["Changes the verification framework or specs: src/verify/specs/TaskTable.verify.ts"]);
  });

  it.each(["package.json", "factory.config.json", "server/basic-auth.ts", "src/auth/session.ts", ".github/workflows/ci.yml"])(
    "is high when %s changes",
    (path) => {
      expect(classifyRisk([mod(path)], policy).level).toBe("high");
    },
  );

  it("is high when tests are deleted or the change is too big", () => {
    expect(classifyRisk([{ path: "src/x.spec.tsx", status: "deleted", added: 0, removed: 5 }], policy).reasons).toContain("Deletes tests: src/x.spec.tsx");
    expect(classifyRisk([mod("src/a.ts", 401)], policy).reasons).toEqual(["Changes 401 lines (limit 400)"]);
    expect(classifyRisk(Array.from({ length: 21 }, (_, i) => mod(`src/f${i}.ts`, 1)), policy).reasons).toEqual(["Changes 21 files (limit 20)"]);
  });

  it("does not count tests the factory wrote and locked, unless they are deleted", () => {
    const spec = "src/verify/specs/TaskTable.verify.ts";
    expect(classifyRisk([mod(spec)], policy, { lockedFiles: [spec] }).level).toBe("low");
    expect(classifyRisk([{ path: spec, status: "deleted", added: 0, removed: 5 }], policy, { lockedFiles: [spec] }).level).toBe("high");
  });
});
