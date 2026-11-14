// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type InitIo, initProject } from "./init";

function project(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "factory-init-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

/** Every tool is present and works, except the commands in `failing`. */
function io(root: string, failing: string[] = []): InitIo & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    out: (t) => lines.push(t),
    run: (cmd, args) => {
      const line = [cmd, ...args].join(" ");
      if (failing.some((f) => line.startsWith(f))) return null;
      if (line === "git rev-parse --show-toplevel") return root;
      return "ok";
    },
  };
}

const npmApp = {
  "package.json": JSON.stringify({ scripts: { dev: "vite", lint: "eslint" }, devDependencies: { vitest: "^3", typescript: "^5" } }),
  "package-lock.json": "{}",
};

describe("factory init", () => {
  it("writes a config for the project's package manager and dev server", () => {
    const dir = project(npmApp);
    expect(initProject(dir, { force: false, json: false }, io(dir))).toBe(0);
    const config = JSON.parse(readFileSync(join(dir, "factory.config.json"), "utf8"));
    expect(config.commands).toMatchObject({ install: "npm ci", lint: "npm run lint", test: "npx --no-install vitest run" });
    expect(config.app).toMatchObject({ start: "npm run dev", url: "http://localhost:5173" });
    expect(config.policy.alwaysHuman.map((r: { pattern: string }) => r.pattern)).toContain("factory.config.json");
  });

  it("skips lint and the app start when the project has no such scripts", () => {
    const dir = project({ "package.json": JSON.stringify({ devDependencies: { vitest: "1", typescript: "5" } }) });
    initProject(dir, { force: false, json: false }, io(dir));
    const config = JSON.parse(readFileSync(join(dir, "factory.config.json"), "utf8"));
    expect(config.commands.lint).toBeUndefined();
    expect(config.commands.test).toBe("pnpm exec vitest run");
    expect(config.app.start).toBeUndefined();
  });

  it("keeps an existing config unless forced", () => {
    const dir = project({ ...npmApp, "factory.config.json": JSON.stringify({ base: "develop" }) });
    initProject(dir, { force: false, json: false }, io(dir));
    expect(JSON.parse(readFileSync(join(dir, "factory.config.json"), "utf8"))).toEqual({ base: "develop" });
    initProject(dir, { force: true, json: false }, io(dir));
    expect(JSON.parse(readFileSync(join(dir, "factory.config.json"), "utf8")).base).toBe("main");
  });

  it("reports what is missing and exits 1", () => {
    const dir = project({ "package.json": "{}" });
    const fake = io(dir, ["claude", "git ls-remote"]);
    expect(initProject(dir, { force: false, json: true }, fake)).toBe(1);
    const { checks } = JSON.parse(fake.lines[0]!) as { checks: Array<{ name: string; ok: boolean; detail: string }> };
    const missing = checks.filter((c) => !c.ok).map((c) => c.name);
    expect(missing).toEqual(["Claude Code", "base branch", "Vitest", "TypeScript"]);
    expect(checks.find((c) => c.name === "base branch")?.detail).toContain("origin/main must exist");
  });

  it("refuses to run outside a git repository", () => {
    const dir = project({});
    expect(initProject(dir, { force: false, json: false }, io(dir, ["git rev-parse"]))).toBe(2);
    expect(existsSync(join(dir, "factory.config.json"))).toBe(false);
  });
});
