// @vitest-environment node
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../shared/config";
import { loadConfig, readProjectConfig } from "./config";

const repo = (config?: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), "factory-config-"));
  if (config !== undefined) writeFileSync(join(dir, "factory.config.json"), JSON.stringify(config));
  return dir;
};
const env = (dir: string, extra: Record<string, string> = {}) => ({ FACTORY_REPO: dir, FACTORY_CHROMIUM: "/bin/chromium", ...extra });

describe("project config", () => {
  it("uses the defaults without a config file", () => {
    const { file, config } = readProjectConfig(repo());
    expect(file).toBeNull();
    expect(config.base).toBe("main");
    expect(config.projectDir).toBe("");
    expect(config.commands.test).toBe("pnpm exec vitest run");
    expect(config.commands.lint).toBeUndefined();
    expect(config.policy).toEqual(DEFAULT_POLICY);
  });

  it("refuses an invalid file", () => {
    expect(() => readProjectConfig(repo({ maxAttempts: "three" }))).toThrow(/maxAttempts/);
  });

  it("reads another repository's config, with the project at its root", () => {
    const dir = repo({ base: "develop", commands: { lint: "npm run lint", test: "npx --no-install vitest run" }, app: { start: "npm run dev", url: "http://localhost:3000" } });
    const config = loadConfig(env(dir), "/somewhere/else");
    expect(config.configFile).toBe(join(dir, "factory.config.json"));
    expect(config.effects).toMatchObject({ repo: dir, projectDir: "", base: "develop", lintCommand: ["npm", "run", "lint"], env: { start: ["npm", "run", "dev"] } });
    expect(config.orchestrator.browserBaseUrl).toBe("http://localhost:3000");
    expect(config.orchestrator.tools).toEqual({ run: ["npm run lint", "pnpm exec tsc --noEmit --pretty false", "npx --no-install vitest run"], deny: expect.arrayContaining(["npm run dev"]) });
  });

  it("lets environment variables override the file", () => {
    const config = loadConfig(env(repo({ base: "develop", maxAttempts: 5 }), { FACTORY_BASE: "main", FACTORY_MAX_ATTEMPTS: "2", FACTORY_LINT: "eslint" }));
    expect(config.effects.base).toBe("main");
    expect(config.orchestrator.maxAttempts).toBe(2);
    expect(config.effects.lintCommand).toEqual(["eslint"]);
  });

  it("reads a config kept outside the repository, and the Jest runner", () => {
    const outside = join(repo(), "elsewhere.json");
    writeFileSync(outside, JSON.stringify({ commands: { test: "pnpm test", testRunner: "jest" } }));
    const config = loadConfig(env(repo(), { FACTORY_CONFIG: outside }));
    expect(config.configFile).toBe(outside);
    expect(config.effects).toMatchObject({ testCommand: ["pnpm", "test"], testRunner: "jest" });
    expect(() => loadConfig(env(repo(), { FACTORY_CONFIG: "/nope/factory.json" }))).toThrow(/does not exist/);
  });

  it("uses the project's own skills folder and stage files", () => {
    const dir = repo({ skills: { dir: ".claude/skills", stages: { design: ["architecture/SKILL.md"], planning: ["plan/SKILL.md"] } } });
    const config = loadConfig(env(dir));
    expect(config.orchestrator.skillsDir).toBe(join(dir, ".claude/skills"));
    expect(config.orchestrator.stageSkills).toEqual({ design: ["architecture/SKILL.md"], planning: ["plan/SKILL.md"] });
    expect(config.planningSkills).toEqual(["plan/SKILL.md"]);
    expect(config.orchestrator.isolation?.skillsDir).toBe(join(dir, ".claude/skills"));
    expect(loadConfig(env(repo())).orchestrator.skillsDir).toMatch(/\.claude\/skills$/);
  });

  it("runs the browser check in Chrome on a signed-in profile when one is set", () => {
    const mcp = loadConfig(env(repo({ app: { browserProfile: "~/.factory/browser-profile" } }))).orchestrator.browserMcp as { args: string[] };
    const command = mcp.args.join(" ");
    expect(command).toContain(`--user-data-dir "${join(homedir(), ".factory/browser-profile")}"`);
    expect(command).not.toContain("--isolated");
    expect(command).not.toContain("--executable-path");
    const fromEnv = loadConfig(env(repo(), { FACTORY_BROWSER_PROFILE: "/profiles/admin" })).orchestrator.browserMcp as { args: string[] };
    expect(fromEnv.args.join(" ")).toContain('--user-data-dir "/profiles/admin"');
  });

  it("always configures the browser tool server, with the factory's own pinned package and Chromium", () => {
    const mcp = loadConfig(env(repo())).orchestrator.browserMcp as { args: string[] };
    expect(mcp.args.join(" ")).toMatch(/node_modules\/\.bin\/playwright-mcp" --headless --ignore-https-errors --isolated --executable-path "\/bin\/chromium"/);
  });
});
