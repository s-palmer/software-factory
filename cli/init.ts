/**
 * `factory init`: set up a repository for the factory. Runs locally, without the API.
 *
 * Writes `factory.config.json` with presets for the project's package manager, then checks what the
 * factory needs (git remote, gh, claude, the base branch, Vitest and TypeScript) and prints what is missing.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, commandsFor, DEFAULT_POLICY, LOCKFILES, PACKAGE_MANAGERS, type PackageManager, ProjectConfig } from "../shared/config";

export type Check = { name: string; ok: boolean; detail: string };

export interface InitIo {
  /** Runs a command and returns its stdout, or null when it fails or does not exist. */
  run: (cmd: string, args: string[], cwd: string) => string | null;
  out: (text: string) => void;
}

export const nodeIo: InitIo = {
  run: (cmd, args, cwd) => {
    try {
      return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  },
  out: (text) => process.stdout.write(`${text}\n`),
};

export function detectPackageManager(dir: string): PackageManager {
  return PACKAGE_MANAGERS.find((pm) => existsSync(join(dir, LOCKFILES[pm]))) ?? "pnpm";
}

type PackageJson = { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

function readPackageJson(dir: string): PackageJson | null {
  const file = join(dir, "package.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as PackageJson) : null;
}

/** The config `factory init` writes: presets for the package manager, the dev server if there is one, the default policy. */
export function defaultConfig(dir: string): ProjectConfig {
  const pm = detectPackageManager(dir);
  const pkg = readPackageJson(dir);
  const scripts = pkg?.scripts ?? {};
  const commands = commandsFor(pm);
  const url = "http://localhost:5173";
  return ProjectConfig.parse({
    commands: scripts.lint ? commands : { ...commands, lint: undefined },
    app: scripts.dev ? { start: `${pm} run dev`, url, healthUrls: [url] } : { url },
    policy: DEFAULT_POLICY,
  });
}

export function initProject(cwd: string, opts: { force: boolean; json: boolean }, io: InitIo = nodeIo): number {
  const root = io.run("git", ["rev-parse", "--show-toplevel"], cwd);
  if (!root) {
    io.out(opts.json ? JSON.stringify({ error: "Not in a git repository" }) : "factory: run init inside the git repository the factory should work on.");
    return 2;
  }
  const file = join(root, CONFIG_FILE);
  const existed = existsSync(file);
  const written = !existed || opts.force;
  const config = written ? defaultConfig(root) : ProjectConfig.parse(JSON.parse(readFileSync(file, "utf8")));
  if (written) writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);

  const pkg = readPackageJson(join(root, config.projectDir));
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const remoteUrl = io.run("git", ["remote", "get-url", config.remote], root);
  const check = (name: string, ok: boolean, fix: string, detail = "ok"): Check => ({ name, ok, detail: ok ? detail : fix });
  const checks: Check[] = [
    check("git remote", !!remoteUrl, `no remote "${config.remote}": git remote add ${config.remote} <url>`, remoteUrl ?? ""),
    check("GitHub CLI", io.run("gh", ["auth", "status"], root) !== null, "install gh and log in: gh auth login"),
    check("GitHub repository", io.run("gh", ["repo", "view", "--json", "name"], root) !== null, "gh repo view must work in this repository"),
    check("Claude Code", io.run("claude", ["--version"], root) !== null, "install Claude Code and log in: claude"),
    check(
      "base branch",
      !!io.run("git", ["ls-remote", "--heads", config.remote, config.base], root),
      `${config.remote}/${config.base} must exist: git push ${config.remote} HEAD:${config.base}`,
    ),
    check("package.json", !!pkg, `no package.json in ${config.projectDir || "the repository root"}`),
    check("Vitest", !!deps.vitest, "the test gate needs Vitest: add vitest as a dev dependency", deps.vitest),
    check("TypeScript", !!deps.typescript, "the type gate needs tsc: add typescript as a dev dependency", deps.typescript),
  ];

  if (opts.json) {
    io.out(JSON.stringify({ configFile: file, written, config, checks }));
  } else {
    io.out(written ? `Wrote ${file}` : `${file} exists; left it unchanged (--force overwrites it)`);
    io.out("");
    for (const c of checks) io.out(`  ${(c.ok ? "ok" : "MISSING").padEnd(7)}  ${c.name}: ${c.detail}`);
    io.out("");
    io.out("Next:");
    io.out(`  1. Check ${CONFIG_FILE}: the commands, app.start and app.url, and the policy.`);
    io.out(`  2. Commit and push it to ${config.remote}/${config.base}.`);
    io.out(`  3. Start the factory for this repository: FACTORY_REPO=${root} pnpm factory:server  (in the factory folder)`);
    io.out(`  4. Give it an issue: factory add --ticket "#1", then: factory start`);
  }
  return checks.every((c) => c.ok) ? 0 : 1;
}
