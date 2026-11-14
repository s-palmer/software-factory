// @vitest-environment node
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

  it("always configures the browser tool server, with the factory's own pinned package and Chromium", () => {
    const mcp = loadConfig(env(repo())).orchestrator.browserMcp as { args: string[] };
    expect(mcp.args.join(" ")).toMatch(/node_modules\/\.bin\/playwright-mcp" --headless --isolated .*--executable-path "\/bin\/chromium"/);
  });
});
