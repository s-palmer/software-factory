// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type InitIo, type InitOptions, initProject } from "./init";

function project(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "factory-init-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

type FakeIo = InitIo & { lines: string[]; questions: string[] };

/**
 * Every tool is present and works, except the commands in `failing`. `answers` replies to the questions in order;
 * `outputs` gives a command's stdout by its prefix.
 */
function io(root: string, opts: { failing?: string[]; answers?: string[]; outputs?: Record<string, string>; platform?: NodeJS.Platform } = {}): FakeIo {
  const lines: string[] = [];
  const questions: string[] = [];
  const answers = [...(opts.answers ?? [])];
  return {
    lines,
    questions,
    platform: opts.platform ?? "darwin",
    out: (t) => void lines.push(t),
    ask: async (q, fallback) => {
      questions.push(q);
      return answers.shift() || fallback;
    },
    run: (cmd, args) => {
      const line = [cmd, ...args].join(" ");
      if ((opts.failing ?? []).some((f) => line.startsWith(f))) return null;
      if (line === "git rev-parse --show-toplevel") return root;
      for (const [prefix, text] of Object.entries(opts.outputs ?? {})) if (line.startsWith(prefix)) return text;
      return "ok";
    },
  };
}

const quiet = (o: Partial<InitOptions> = {}): InitOptions => ({ force: false, json: false, interactive: false, ...o });
const readConfig = (dir: string) => JSON.parse(readFileSync(join(dir, "factory.config.json"), "utf8"));

const npmApp = {
  "package.json": JSON.stringify({ scripts: { dev: "vite", lint: "eslint" }, devDependencies: { vitest: "^3", typescript: "^5" } }),
  "package-lock.json": "{}",
};

describe("factory init", () => {
  it("writes a config for the project's package manager and dev server", async () => {
    const dir = project(npmApp);
    expect(await initProject(dir, quiet(), io(dir, { failing: ["git symbolic-ref"] }))).toBe(0);
    const config = readConfig(dir);
    expect(config.commands).toMatchObject({ install: "npm ci", lint: "npm run lint", test: "npx --no-install vitest run" });
    expect(config.app).toMatchObject({ start: "npm run dev", url: "http://localhost:5173" });
    expect(config).toMatchObject({ base: "main", tracker: { type: "github" } });
    expect(config.policy.alwaysHuman.map((r: { pattern: string }) => r.pattern)).toContain("factory.config.json");
  });

  it("skips lint and the app start when the project has no such scripts", async () => {
    const dir = project({ "package.json": JSON.stringify({ devDependencies: { vitest: "1", typescript: "5" } }) });
    await initProject(dir, quiet(), io(dir));
    const config = readConfig(dir);
    expect(config.commands.lint).toBeUndefined();
    expect(config.commands.test).toBe("pnpm exec vitest run");
    expect(config.app.start).toBeUndefined();
  });

  it("walks a person through the choices in a terminal", async () => {
    const dir = project(npmApp);
    const fake = io(dir, {
      answers: ["", "jira", "develop", "npm run start:web", "http://localhost:3000"],
      outputs: { "claude mcp get jira": "jira:\n  Status: ✔ Connected\n  URL: https://mcp.atlassian.com/v2/mcp" },
    });
    expect(await initProject(dir, quiet({ interactive: true }), fake)).toBe(0);
    expect(fake.questions[0]).toMatch(/Repository/);
    expect(fake.questions[1]).toMatch(/tickets/);
    const config = readConfig(dir);
    expect(config).toMatchObject({ base: "develop", app: { start: "npm run start:web", url: "http://localhost:3000", healthUrls: ["http://localhost:3000"] } });
    expect(config.tracker).toMatchObject({ type: "mcp", name: "jira", server: { url: "https://mcp.atlassian.com/v2/mcp" } });
    expect(fake.lines.join("\n")).toContain('"jira" connected');
  });

  it("tells you which MCP server to add and how to sign in", async () => {
    const dir = project(npmApp);
    const fake = io(dir, { failing: ["claude mcp get"] });
    expect(await initProject(dir, quiet({ tracker: "linear" }), fake)).toBe(1);
    const text = fake.lines.join("\n");
    expect(text).toContain("claude mcp add --scope user --transport http linear https://mcp.linear.app/mcp/readonly");
    expect(text).toContain("run /mcp");
    expect(text).toMatch(/MISSING\s+Linear MCP server/);
  });

  it("flags an MCP server that is added but not signed in", async () => {
    const dir = project(npmApp);
    const fake = io(dir, { outputs: { "claude mcp get jira": "jira:\n  Status: ⚠ Needs authentication\n  URL: https://mcp.atlassian.com/v2/mcp" } });
    expect(await initProject(dir, quiet({ tracker: "jira", json: true }), fake)).toBe(1);
    const { checks, mcpSetup } = JSON.parse(fake.lines[0]!) as { checks: Array<{ name: string; ok: boolean; detail: string }>; mcpSetup: string[] };
    expect(checks.find((c) => c.name === "Jira MCP server")?.detail).toContain("not signed in");
    expect(mcpSetup.join(" ")).toContain("claude mcp add --scope user --transport http jira https://mcp.atlassian.com/v2/mcp");
  });

  it("keeps an existing config unless forced or confirmed", async () => {
    const dir = project({ ...npmApp, "factory.config.json": JSON.stringify({ base: "develop" }) });
    await initProject(dir, quiet(), io(dir));
    expect(readConfig(dir)).toEqual({ base: "develop" });
    await initProject(dir, quiet({ interactive: true }), io(dir, { answers: ["", "no"] }));
    expect(readConfig(dir)).toEqual({ base: "develop" });
    await initProject(dir, quiet({ force: true }), io(dir, { failing: ["git symbolic-ref"] }));
    expect(readConfig(dir).base).toBe("main");
  });

  it("reports what is missing and exits 1", async () => {
    const dir = project({ "package.json": "{}" });
    const fake = io(dir, { failing: ["claude", "git ls-remote", "git symbolic-ref"], platform: "linux" });
    expect(await initProject(dir, quiet({ json: true }), fake)).toBe(1);
    const { checks } = JSON.parse(fake.lines[0]!) as { checks: Array<{ name: string; ok: boolean; detail: string }> };
    expect(checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["Claude Code", "base branch", "Vitest", "TypeScript"]);
    expect(checks.find((c) => c.name === "base branch")?.detail).toContain("origin/main must exist");
    expect(checks.map((c) => c.name)).toContain("sandbox (bubblewrap, socat)");
  });

  it("copies the verification framework into a React and Vite app", async () => {
    const dir = project({ "package.json": JSON.stringify({ dependencies: { react: "19", "react-dom": "19" }, devDependencies: { vite: "8", vitest: "5", typescript: "5" } }) });
    const fake = io(dir);
    expect(await initProject(dir, quiet({ json: true }), fake)).toBe(1);
    const out = JSON.parse(fake.lines[0]!) as { verifyFiles: string[]; checks: Array<{ name: string; ok: boolean; detail: string }> };
    for (const f of ["src/verify/core/registry.ts", "src/verify/harness/UnitPage.tsx", "src/verify/verifiers/a11y.ts", "src/verify/entry.tsx", "src/verify/matrix.test.ts", "src/verify/specs/index.ts", "src/verify/README.md", "verify.html"]) {
      expect(out.verifyFiles).toContain(f);
      expect(existsSync(join(dir, f))).toBe(true);
    }
    expect(out.verifyFiles.some((f) => f.endsWith(".test.ts") && f !== "src/verify/matrix.test.ts")).toBe(false);
    expect(readFileSync(join(dir, "verify.html"), "utf8")).toContain('src="/src/verify/entry.tsx"');
    expect(readFileSync(join(dir, "src/verify/entry.tsx"), "utf8")).toContain("`/verify.html?unit=");
    const config = readConfig(dir);
    expect(config.verify).toEqual({ enabled: true, dir: "src/verify", entry: "/verify.html" });
    expect(config.policy.alwaysHuman.map((r: { pattern: string }) => r.pattern)).toEqual(expect.arrayContaining(["src/verify/core/**", "verify.html"]));
    expect(out.checks.find((c) => c.name === "verification dependencies")?.detail).toBe("add them: pnpm add -D zod jsdom");
  });

  it("leaves verification out when asked, and never replaces the specs", async () => {
    const reactApp = { "package.json": JSON.stringify({ dependencies: { react: "19" }, devDependencies: { vite: "8" } }) };
    const off = project(reactApp);
    await initProject(off, quiet({ verify: false }), io(off));
    expect(readConfig(off).verify.enabled).toBe(false);
    expect(existsSync(join(off, "src/verify"))).toBe(false);

    const on = project(reactApp);
    await initProject(on, quiet(), io(on));
    writeFileSync(join(on, "src/verify/specs/index.ts"), 'import "./Cart.verify";\n');
    await initProject(on, quiet({ force: true }), io(on));
    expect(readFileSync(join(on, "src/verify/specs/index.ts"), "utf8")).toBe('import "./Cart.verify";\n');
  });

  it("refuses a folder that is not a git repository", async () => {
    const dir = project({});
    expect(await initProject(dir, quiet(), io(dir, { failing: ["git rev-parse"] }))).toBe(2);
    expect(existsSync(join(dir, "factory.config.json"))).toBe(false);
  });
});
