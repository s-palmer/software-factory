/**
 * `factory init`: set up a repository for the factory. Runs locally, without the API.
 *
 * In a terminal it asks for the repository, the ticket system, the base branch and how to start the app. With
 * `--yes` (or `--json`) it takes the flags and the defaults. Then it writes `factory.config.json`, checks what
 * the factory needs, and prints how to fix what is missing, including the MCP server to add for Jira or Linear.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_FILE,
  commandsFor,
  DEFAULT_POLICY,
  LOCKFILES,
  PACKAGE_MANAGERS,
  type PackageManager,
  ProjectConfig,
  TRACKER_PRESETS,
  type TrackerConfig,
} from "../shared/config";

export type Check = { name: string; ok: boolean; detail: string };

export type TrackerChoice = keyof typeof TRACKER_PRESETS;

export interface InitOptions {
  force: boolean;
  json: boolean;
  /** Ask questions; false takes the flags and the defaults. */
  interactive: boolean;
  repo?: string | undefined;
  tracker?: TrackerChoice | undefined;
  base?: string | undefined;
  start?: string | undefined;
  url?: string | undefined;
  /** Copy in the runtime verification framework. Default: yes for a React and Vite app. */
  verify?: boolean | undefined;
}

/** The factory's own copy of the framework, and the files it adds around it in a target repository. */
const FACTORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const FRAMEWORK_DIRS = ["core", "verifiers", "harness"];
const TEMPLATES = join(FACTORY_ROOT, "templates/verify");

export function isReactVite(dir: string): boolean {
  const pkg = readPackageJson(dir);
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  return Boolean(deps.react && deps.vite);
}

/**
 * Copies the verification framework into `<projectDir>/<verify.dir>` and the harness page next to the app's
 * index.html. Framework files are replaced only with `force`; specs are never touched.
 */
export function installVerify(projectRoot: string, verify: ProjectConfig["verify"], force: boolean): string[] {
  const dir = join(projectRoot, verify.dir);
  const written: string[] = [];
  const fill = (text: string) => text.replaceAll("{{dir}}", verify.dir).replaceAll("{{entry}}", verify.entry);
  const put = (file: string, text: string, overwrite: boolean) => {
    if (existsSync(file) && !overwrite) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    written.push(relative(projectRoot, file));
  };
  for (const sub of FRAMEWORK_DIRS) {
    const from = join(FACTORY_ROOT, "src/verify", sub);
    for (const name of readdirSync(from)) {
      if (/\.test\.tsx?$/.test(name)) continue;
      const to = join(dir, sub, name);
      if (existsSync(to) && !force) continue;
      mkdirSync(dirname(to), { recursive: true });
      cpSync(join(from, name), to);
      written.push(relative(projectRoot, to));
    }
  }
  put(join(dir, "entry.tsx"), fill(readFileSync(join(TEMPLATES, "entry.tsx"), "utf8")), force);
  put(join(dir, "matrix.test.ts"), fill(readFileSync(join(TEMPLATES, "matrix.test.ts"), "utf8")), force);
  put(join(dir, "README.md"), fill(readFileSync(join(TEMPLATES, "README.md"), "utf8")), force);
  put(join(dir, "specs/index.ts"), readFileSync(join(TEMPLATES, "specs/index.ts"), "utf8"), false);
  put(join(projectRoot, verify.entry.replace(/^\//, "")), fill(readFileSync(join(TEMPLATES, "verify.html"), "utf8")), force);
  return written;
}

/** Paths an agent must not change without a person: the framework that judges its work. */
export function verifyPolicy(verify: ProjectConfig["verify"]) {
  return [
    ...FRAMEWORK_DIRS.map((sub) => ({ pattern: `${verify.dir}/${sub}/**`, reason: "Changes the verification framework" })),
    { pattern: `${verify.dir}/entry.tsx`, reason: "Changes the verification harness" },
    { pattern: verify.entry.replace(/^\//, ""), reason: "Changes the verification harness" },
  ];
}

export interface InitIo {
  /** Runs a command and returns its stdout, or null when it fails or does not exist. */
  run: (cmd: string, args: string[], cwd: string) => string | null;
  out: (text: string) => void;
  /** Asks a question; an empty answer takes the default. Only called when interactive. */
  ask: (question: string, fallback: string) => Promise<string>;
  platform: NodeJS.Platform;
}

export const nodeIo = (ask: InitIo["ask"]): InitIo => ({
  run: (cmd, args, cwd) => {
    try {
      return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  },
  out: (text) => process.stdout.write(`${text}\n`),
  ask,
  platform: process.platform,
});

export function detectPackageManager(dir: string): PackageManager {
  return PACKAGE_MANAGERS.find((pm) => existsSync(join(dir, LOCKFILES[pm]))) ?? "pnpm";
}

type PackageJson = { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

function readPackageJson(dir: string): PackageJson | null {
  const file = join(dir, "package.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as PackageJson) : null;
}

/** The config `factory init` writes: presets for the package manager, the dev server if there is one, the default policy. */
export function defaultConfig(dir: string, choices: { tracker?: TrackerChoice; base?: string; start?: string | null; url?: string; verify?: boolean } = {}): ProjectConfig {
  const pm = detectPackageManager(dir);
  const pkg = readPackageJson(dir);
  const scripts = pkg?.scripts ?? {};
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  // A Jest project runs its tests through its own test script.
  const jest = Boolean(deps.jest) && !deps.vitest;
  const commands = { ...commandsFor(pm), ...(jest ? { test: scripts.test ? `${pm} test` : `${pm} exec jest`, testRunner: "jest" as const } : {}) };
  const url = choices.url ?? "http://localhost:5173";
  const start = choices.start === undefined ? (scripts.dev ? `${pm} run dev` : null) : choices.start;
  // The verification matrix test runs on Vitest.
  const verify = ProjectConfig.shape.verify.parse({ enabled: (choices.verify ?? false) && !jest });
  return ProjectConfig.parse({
    ...(choices.base ? { base: choices.base } : {}),
    commands: scripts.lint ? commands : { ...commands, lint: undefined },
    app: start ? { start, url, healthUrls: [url] } : { url },
    policy: verify.enabled ? { ...DEFAULT_POLICY, alwaysHuman: [...DEFAULT_POLICY.alwaysHuman, ...verifyPolicy(verify)] } : DEFAULT_POLICY,
    tracker: TRACKER_PRESETS[choices.tracker ?? "github"],
    verify,
  });
}

/** How to give agent runs access to an MCP tracker: add it to Claude Code under the same name, then sign in once. */
export function mcpSetup(tracker: TrackerConfig): string[] {
  if (tracker.type !== "mcp") return [];
  const url = typeof tracker.server.url === "string" ? tracker.server.url : null;
  const add = url
    ? `claude mcp add --scope user --transport http ${tracker.name} ${url}`
    : `claude mcp add-json --scope user ${tracker.name} '${JSON.stringify(tracker.server)}'`;
  return [
    `${tracker.label} through MCP: agents read tickets with the "${tracker.name}" server and its read tools only.`,
    `  1. Add the server to Claude Code under the same name:  ${add}`,
    `  2. Start claude, run /mcp, choose "${tracker.name}" and sign in. Agent runs reuse that sign-in.`,
    `  3. Check it: claude -p "Read ticket <KEY> with the ${tracker.name} tools and give its title"`,
  ];
}

const TRACKERS = Object.keys(TRACKER_PRESETS) as TrackerChoice[];

async function choose(io: InitIo, opts: InitOptions, root: string): Promise<{ tracker: TrackerChoice; base: string; start: string | null; url: string; verify: boolean }> {
  const pm = detectPackageManager(root);
  const scripts = readPackageJson(root)?.scripts ?? {};
  const remoteHead = io.run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root)?.replace(/^origin\//, "");
  const defaults = {
    tracker: opts.tracker ?? "github",
    base: opts.base ?? remoteHead ?? "main",
    start: opts.start ?? (scripts.dev ? `${pm} run dev` : ""),
    url: opts.url ?? "http://localhost:5173",
    verify: opts.verify ?? isReactVite(root),
  };
  if (!opts.interactive) return { ...defaults, start: defaults.start || null };

  let tracker = defaults.tracker;
  for (;;) {
    const answer = (await io.ask(`Where do your tickets live? (${TRACKERS.join(", ")})`, tracker)).trim().toLowerCase();
    if ((TRACKERS as string[]).includes(answer)) {
      tracker = answer as TrackerChoice;
      break;
    }
    io.out(`  Choose one of: ${TRACKERS.join(", ")}. For another tracker, choose any and edit "tracker" in ${CONFIG_FILE}.`);
  }
  const base = (await io.ask("Base branch: tasks start from it and pull requests target it", defaults.base)).trim();
  io.out(`  Package manager: ${pm} (from the lockfile).`);
  const start = (await io.ask('Command that starts your app for the browser check ("none" to skip)', defaults.start || "none")).trim();
  const url = start && start !== "none" ? (await io.ask("URL the app answers on", defaults.url)).trim() : defaults.url;
  let verify = false;
  if (opts.verify !== undefined) verify = opts.verify;
  else if (isReactVite(root)) {
    verify = /^y/i.test(
      await io.ask("React and Vite found. Add runtime verification (the agents write a .verify.ts spec per UI component, checked in jsdom and the browser)?", "yes"),
    );
  }
  return { tracker, base: base || defaults.base, start: start && start !== "none" ? start : null, url: url || defaults.url, verify };
}

export async function initProject(cwd: string, opts: InitOptions, io: InitIo): Promise<number> {
  let dir = opts.repo ? resolve(cwd, opts.repo) : cwd;
  if (opts.interactive && !opts.repo) {
    const here = io.run("git", ["rev-parse", "--show-toplevel"], cwd) ?? cwd;
    dir = resolve(cwd, (await io.ask("Repository the factory should work on", here)).trim() || here);
  }
  const root = io.run("git", ["rev-parse", "--show-toplevel"], dir);
  if (!root) {
    io.out(opts.json ? JSON.stringify({ error: `Not a git repository: ${dir}` }) : `factory: ${dir} is not a git repository.`);
    return 2;
  }
  const file = join(root, CONFIG_FILE);
  const existed = existsSync(file);
  let write = !existed || opts.force;
  if (existed && !opts.force && opts.interactive) write = /^y/i.test(await io.ask(`${CONFIG_FILE} exists. Replace it?`, "no"));
  const config = write ? defaultConfig(root, await choose(io, opts, root)) : ProjectConfig.parse(JSON.parse(readFileSync(file, "utf8")));
  if (write) writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  const projectRoot = join(root, config.projectDir);
  const verifyFiles = config.verify.enabled ? installVerify(projectRoot, config.verify, opts.force) : [];

  const checks = runChecks(io, root, config);
  if (opts.json) {
    io.out(JSON.stringify({ configFile: file, written: write, config, checks, mcpSetup: mcpSetup(config.tracker), verifyFiles }));
  } else {
    io.out("");
    io.out(write ? `Wrote ${file}` : `${file} exists; left it unchanged (--force replaces it)`);
    if (verifyFiles.length) io.out(`Added the verification framework: ${verifyFiles.length} files in ${config.verify.dir}/ and ${config.verify.entry.replace(/^\//, "")} (see ${config.verify.dir}/README.md).`);
    io.out("");
    for (const c of checks) io.out(`  ${(c.ok ? "ok" : "MISSING").padEnd(7)}  ${c.name}: ${c.detail}`);
    const setup = mcpSetup(config.tracker);
    if (setup.length) {
      io.out("");
      for (const line of setup) io.out(line);
    }
    io.out("");
    io.out("Next:");
    io.out(`  1. Read ${CONFIG_FILE}: the commands, the app, the policy and the sandbox's allowed hosts.`);
    io.out(`  2. Commit it and push it to ${config.remote}/${config.base}.`);
    io.out(`  3. In the factory folder: FACTORY_REPO=${root} pnpm factory:server, and pnpm dev for the dashboard.`);
    io.out(`  4. Give it a ticket: factory add --ticket ${config.tracker.type === "github" ? '"#1"' : "PROJ-1"}, then: factory start`);
  }
  return checks.every((c) => c.ok) ? 0 : 1;
}

function runChecks(io: InitIo, root: string, config: ProjectConfig): Check[] {
  const pkg = readPackageJson(join(root, config.projectDir));
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const remoteUrl = io.run("git", ["remote", "get-url", config.remote], root);
  const check = (name: string, ok: boolean, fix: string, detail = "ok"): Check => ({ name, ok, detail: ok ? detail : fix });
  const checks: Check[] = [
    check("git remote", !!remoteUrl, `no remote "${config.remote}": git remote add ${config.remote} <url>`, remoteUrl ?? ""),
    check("GitHub CLI", io.run("gh", ["auth", "status"], root) !== null, "install gh and log in: gh auth login"),
    check("GitHub repository", io.run("gh", ["repo", "view", "--json", "name"], root) !== null, "gh repo view must work in this repository: pull requests go to GitHub"),
    check("Claude Code", io.run("claude", ["--version"], root) !== null, "install Claude Code and log in: claude"),
    check(
      "base branch",
      !!io.run("git", ["ls-remote", "--heads", config.remote, config.base], root),
      `${config.remote}/${config.base} must exist: git push ${config.remote} HEAD:${config.base}`,
    ),
    check("package.json", !!pkg, `no package.json in ${config.projectDir || "the repository root"}`),
    config.commands.testRunner === "jest"
      ? check("Jest", !!deps.jest, "commands.testRunner is jest, but jest is not a dependency", deps.jest)
      : check("Vitest", !!deps.vitest, "the test gate needs Vitest or Jest: add vitest as a dev dependency, or set commands.testRunner", deps.vitest),
    check("TypeScript", !!deps.typescript, "the type gate needs tsc: add typescript as a dev dependency", deps.typescript),
  ];
  if (config.tracker.type === "mcp") {
    const name = config.tracker.name;
    const info = io.run("claude", ["mcp", "get", name], root);
    const url = typeof config.tracker.server.url === "string" ? config.tracker.server.url : null;
    const status = /Status:\s*(.+)/.exec(info ?? "")?.[1]?.trim() ?? "";
    const fix = !info
      ? `not added to Claude Code as "${name}" (see below)`
      : url && !info.includes(url)
        ? `"${name}" in Claude Code points somewhere else than ${url}`
        : `added but not signed in (${status || "unknown status"}): run /mcp in claude and sign in to "${name}"`;
    checks.push(check(`${config.tracker.label} MCP server`, !!info && (!url || info.includes(url)) && /connected/i.test(status), fix, `"${name}" connected`));
  }
  if (config.verify.enabled) {
    const missing = ["react", "react-dom", "zod", "jsdom"].filter((d) => !deps[d]);
    checks.push(check("verification dependencies", missing.length === 0, `add them: ${detectPackageManager(join(root, config.projectDir))} add -D ${missing.join(" ")}`, "react, react-dom, zod, jsdom"));
  }
  // The agents' shell commands run in Claude Code's sandbox; on Linux it needs bubblewrap and socat.
  if (io.platform === "linux") {
    const ok = io.run("sh", ["-c", "command -v bwrap && command -v socat"], root) !== null;
    checks.push(check("sandbox (bubblewrap, socat)", ok, "install them, for example with sudo apt-get install bubblewrap socat"));
  }
  return checks;
}
