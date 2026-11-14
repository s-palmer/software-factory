/**
 * Factory configuration. The project settings come from `factory.config.json` at the root of the target
 * repository (shared/config.ts); environment variables override single fields. The factory's own files
 * (skills, prompts, the browser tool server) come from this install.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE, ProjectConfig, type TrackerConfig } from "../shared/config";
import { RiskPolicy } from "../shared/risk";
import type { EffectsConfig } from "./effects";
import type { OrchestratorConfig } from "./orchestrator";

type Env = Record<string, string | undefined>;

/** The folder this factory is installed in. */
export const FACTORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** The phase skills every stage reads. They belong to the factory, not to the target repository. */
export const SKILLS_DIR = join(FACTORY_ROOT, ".claude/skills");

const words = (value: string): string[] => value.trim().split(/\s+/).filter(Boolean);
const num = (value: string | undefined, fallback: number): number => (value && Number.isFinite(Number(value)) ? Number(value) : fallback);

export interface FactoryConfig {
  enabled: boolean;
  autostart: boolean;
  /** Where the project settings came from, or null when the file does not exist. */
  configFile: string | null;
  /** The database file. */
  db: string;
  policy: RiskPolicy;
  tracker: TrackerConfig;
  /** The PM run's skill files, when the project replaces them. */
  planningSkills: string[] | undefined;
  /** The Chromium the browser check uses. The server refuses to start the loop when it is missing. */
  chromium: string;
  effects: EffectsConfig;
  orchestrator: Omit<OrchestratorConfig, "policy">;
}

/** Reads and validates `factory.config.json` in `repo`. A missing file gives the defaults; an invalid one throws. */
export function readProjectConfig(repo: string, path?: string): { file: string | null; config: ProjectConfig } {
  const file = path ? resolve(path) : join(repo, CONFIG_FILE);
  if (path && !existsSync(file)) throw new Error(`FACTORY_CONFIG points to ${file}, which does not exist`);
  if (!existsSync(file)) return { file: null, config: ProjectConfig.parse({}) };
  const parsed = ProjectConfig.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`${file} is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return { file, config: parsed.data };
}

/**
 * The Chromium that `pnpm exec playwright install chromium` installs. The browser tool server uses it,
 * so one install serves the factory's own browser tests and the agents' browser check.
 */
export function chromiumPath(): string {
  const require = createRequire(import.meta.url);
  const { chromium } = require("@playwright/test") as { chromium: { executablePath(): string } };
  return chromium.executablePath();
}

/**
 * Where the factory keeps its state for one target repository: outside both repositories, so a branch change,
 * `git clean` or a second target never touches it. `~/.factory/<repo name>/` holds the database, the artifacts
 * and the task worktrees.
 */
export function factoryPaths(env: Env = process.env, cwd = process.cwd()): { repo: string; home: string; db: string; artifacts: string } {
  const repo = resolve(env.FACTORY_REPO ?? execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim());
  const home = resolve(env.FACTORY_HOME ?? join(homedir(), ".factory", basename(repo)));
  return {
    repo,
    home,
    db: env.FACTORY_DB === ":memory:" ? ":memory:" : resolve(cwd, env.FACTORY_DB ?? join(home, "factory.duckdb")),
    artifacts: resolve(cwd, env.FACTORY_ARTIFACTS ?? join(home, "artifacts")),
  };
}

export function loadConfig(env: Env = process.env, cwd = process.cwd()): FactoryConfig {
  const { repo, home, db, artifacts } = factoryPaths(env, cwd);
  // FACTORY_CONFIG: a config kept outside the repository, for example to try the factory without adding a file to it.
  const { file, config: project } = readProjectConfig(repo, env.FACTORY_CONFIG);
  // Fail fast on an invalid policy file: a typo must never silently loosen what needs a person.
  const policy = env.FACTORY_POLICY ? RiskPolicy.parse(JSON.parse(readFileSync(env.FACTORY_POLICY, "utf8"))) : project.policy;

  const browserLibs = env.FACTORY_BROWSER_LIBS ?? join(homedir(), ".local/share/factory/chromium-libs");
  const libPath = [join(browserLibs, "usr/lib/x86_64-linux-gnu"), join(browserLibs, "lib/x86_64-linux-gnu")].filter(existsSync).join(":");
  const chromium = env.FACTORY_CHROMIUM ?? chromiumPath();
  const profileSetting = env.FACTORY_BROWSER_PROFILE ?? project.app.browserProfile;
  const browserProfile = profileSetting ? resolve(profileSetting.replace(/^~(?=\/)/, homedir())) : null;
  // The browser tool server is pinned in package.json and starts outside the repository, so it never reads the project's files.
  // A signed-in profile runs in Google Chrome: Chrome encrypts its saved sign-in with a key only Chrome can read.
  const mcpBin = join(FACTORY_ROOT, "node_modules/.bin/playwright-mcp");
  const browserArgs = browserProfile ? `--user-data-dir ${JSON.stringify(browserProfile)}` : `--isolated --executable-path ${JSON.stringify(chromium)}`;
  const browserMcp = {
    command: "sh",
    args: ["-c", `cd ${JSON.stringify(home)} && exec ${JSON.stringify(mcpBin)} --headless --ignore-https-errors ${browserArgs}`],
    ...(libPath ? { env: { LD_LIBRARY_PATH: libPath } } : {}),
  };
  const start = env.FACTORY_ENV_START ?? project.app.start;
  // Your own skills replace the factory's (Matt Pocock's skills by default).
  const skillsDir = project.skills.dir ? resolve(repo, project.skills.dir) : SKILLS_DIR;
  const commands = {
    install: env.FACTORY_INSTALL || project.commands.install,
    sync: env.FACTORY_SYNC || project.commands.sync,
    lint: env.FACTORY_LINT || project.commands.lint || null,
    typecheck: env.FACTORY_TYPECHECK || project.commands.typecheck,
    test: env.FACTORY_TEST || project.commands.test,
  };

  return {
    enabled: env.FACTORY_ORCHESTRATOR !== "0",
    autostart: env.FACTORY_AUTOSTART === "1",
    configFile: file,
    db,
    policy,
    tracker: project.tracker,
    planningSkills: project.skills.stages.planning,
    chromium,
    effects: {
      repo,
      projectDir: env.FACTORY_PROJECT_DIR ?? project.projectDir,
      remote: env.FACTORY_REMOTE ?? project.remote,
      base: env.FACTORY_BASE ?? project.base,
      home,
      claudeCommand: words(env.FACTORY_CLAUDE_COMMAND ?? "claude"),
      installCommand: words(commands.install),
      syncCommand: words(commands.sync),
      lintCommand: commands.lint ? words(commands.lint) : null,
      typecheckCommand: words(commands.typecheck),
      testCommand: words(commands.test),
      testRunner: project.commands.testRunner,
      env: {
        start: start ? words(start) : null,
        healthUrls: env.FACTORY_ENV_HEALTH ? env.FACTORY_ENV_HEALTH.split(",").map((u) => u.trim()).filter(Boolean) : project.app.healthUrls,
        logLines: 60,
      },
    },
    orchestrator: {
      artifactRoot: artifacts,
      maxAttempts: num(env.FACTORY_MAX_ATTEMPTS, project.maxAttempts),
      guardScript: fileURLToPath(new URL("./guard.mjs", import.meta.url)),
      envStartTimeoutMs: num(env.FACTORY_ENV_START_TIMEOUT_MS, project.app.startTimeoutMs),
      browserBaseUrl: env.FACTORY_BROWSER_URL ?? project.app.url,
      browserMcp,
      skillsDir,
      stageSkills: project.skills.stages,
      tracker: project.tracker.type === "mcp" ? project.tracker : undefined,
      verify: project.verify.enabled ? { dir: project.verify.dir, entry: project.verify.entry } : undefined,
      isolation: { repo, home, skillsDir, allowedDomains: project.sandbox.allowedDomains, allowRead: project.sandbox.allowRead },
      // The agents may run the checks themselves, but never install packages or start the app.
      tools: { run: [commands.lint, commands.typecheck, commands.test].filter((c): c is string => !!c), deny: [commands.install, commands.sync, ...(start ? [start] : [])] },
      tickMs: num(env.FACTORY_TICK_MS, 5000),
    },
  };
}
