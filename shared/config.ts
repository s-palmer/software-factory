/**
 * The project config file, `factory.config.json` at the root of the repository the factory works on.
 * `factory init` writes it. Every field has a default, so `{}` is a valid file. Environment variables
 * override single fields (server/config.ts).
 */
import { z } from "zod";
import { RiskPolicy } from "./risk";

export const CONFIG_FILE = "factory.config.json";

export const PACKAGE_MANAGERS = ["pnpm", "npm", "yarn", "bun"] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/** The lockfile of each package manager. The factory reinstalls dependencies when it changes. */
export const LOCKFILES: Record<PackageManager, string> = {
  pnpm: "pnpm-lock.yaml",
  npm: "package-lock.json",
  yarn: "yarn.lock",
  bun: "bun.lock",
};

/** Command presets per package manager. `test` must run Vitest: the gate adds Vitest's JSON reporter flags. */
export function commandsFor(pm: PackageManager) {
  const exec = { pnpm: "pnpm exec", npm: "npx --no-install", yarn: "yarn exec", bun: "bunx --no-install" }[pm];
  const install = { pnpm: "pnpm install --frozen-lockfile --prefer-offline", npm: "npm ci", yarn: "yarn install --immutable", bun: "bun install --frozen-lockfile" }[pm];
  const sync = { pnpm: "pnpm install --no-frozen-lockfile --prefer-offline", npm: "npm install", yarn: "yarn install", bun: "bun install" }[pm];
  return {
    install,
    sync,
    lint: `${pm} run lint`,
    typecheck: `${exec} tsc --noEmit --pretty false`,
    test: `${exec} vitest run`,
  };
}

/** Paths that always make a pull request high risk, for any project. */
export const DEFAULT_POLICY: RiskPolicy = {
  alwaysHuman: [
    { pattern: CONFIG_FILE, reason: "Changes the factory config or risk policy" },
    { pattern: "**/*.test.*", reason: "Changes unit tests" },
    { pattern: "**/*.spec.*", reason: "Changes tests" },
    { pattern: "e2e/**", reason: "Changes the browser tests" },
    { pattern: "package.json", reason: "Adds or changes dependencies or scripts" },
    ...Object.values(LOCKFILES).map((pattern) => ({ pattern, reason: "Changes installed dependencies" })),
    { pattern: "tsconfig*.json", reason: "Changes type-checking rules" },
    { pattern: "vite.config.*", reason: "Changes build or test configuration" },
    { pattern: "vitest.config.*", reason: "Changes test configuration" },
    { pattern: "playwright.config.*", reason: "Changes browser test configuration" },
    { pattern: "**/auth/**", reason: "Touches authentication" },
    { pattern: "**/payments/**", reason: "Touches payments" },
    { pattern: "**/migrations/**", reason: "Changes the database schema" },
    { pattern: "**/.env*", reason: "Touches secrets or environment configuration" },
    { pattern: ".github/**", reason: "Changes CI or deployment" },
  ],
  maxChangedFiles: 20,
  maxChangedLines: 400,
};

const pnpm = commandsFor("pnpm");

/**
 * Where tickets live. `github`: the factory reads the issue with `gh` and puts it in every prompt. `mcp`: agents
 * read the ticket themselves through an MCP server (Jira, Linear, or any tracker with one), with read tools only.
 * Pull requests always go to GitHub.
 */
export const TrackerConfig = z.discriminatedUnion("type", [
  z.object({ type: z.literal("github") }),
  z.object({
    type: z.literal("mcp"),
    /** The server name in the agents' MCP config. Use the name you signed in with in Claude Code (`/mcp`). */
    name: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    /** Shown in prompts and the dashboard, such as "Jira". */
    label: z.string().min(1),
    /** An MCP server entry, as in `.mcp.json`: `{ "type": "http", "url": ... }` or `{ "command": ..., "args": [...] }`. */
    server: z.record(z.string(), z.unknown()),
    /** The tools agents may call, without the `mcp__<name>__` prefix. "*" allows every tool: use it only for a read-only server. */
    tools: z.union([z.literal("*"), z.array(z.string().min(1)).min(1)]),
    /** A pattern a ticket key must match, as a regular expression source. */
    keyPattern: z.string().optional(),
    /** How to read a ticket with these tools. The prompt adds the key. */
    instructions: z.string().min(1),
  }),
]);
export type TrackerConfig = z.infer<typeof TrackerConfig>;

/** Presets `factory init --tracker <name>` writes. */
export const TRACKER_PRESETS: Record<"github" | "jira" | "linear", TrackerConfig> = {
  github: { type: "github" },
  jira: {
    type: "mcp",
    name: "jira",
    label: "Jira",
    server: { type: "http", url: "https://mcp.atlassian.com/v2/mcp" },
    tools: [
      "getAccessibleAtlassianResources",
      "getJiraIssue",
      "search",
      "searchJiraIssuesUsingJql",
      "listJiraIssueComments",
      "getConfluenceContent",
      "searchConfluence",
      "discover",
      "executeRead",
    ],
    keyPattern: "^[A-Z][A-Z0-9]+-\\d+$",
    instructions: "Read it with getJiraIssue (get the cloudId from getAccessibleAtlassianResources first), and its comments with listJiraIssueComments. Follow linked Confluence pages with getConfluenceContent.",
  },
  linear: {
    type: "mcp",
    name: "linear",
    label: "Linear",
    // The read-only endpoint exposes read tools only, so every tool can be allowed.
    server: { type: "http", url: "https://mcp.linear.app/mcp/readonly" },
    tools: "*",
    keyPattern: "^[A-Z][A-Z0-9]+-\\d+$",
    instructions: "Read the issue, its description and its comments with the Linear tools.",
  },
};

export const ProjectConfig = z.object({
  /** The branch tasks start from and pull requests target. It must exist on the remote. */
  base: z.string().min(1).default("main"),
  remote: z.string().min(1).default("origin"),
  /** The app's folder inside the repository, for a monorepo. "" is the repository root. */
  projectDir: z.string().default(""),
  commands: z
    .object({
      install: z.string().min(1).default(pnpm.install),
      sync: z.string().min(1).default(pnpm.sync),
      /** Gets the changed files appended. Leave it out to skip the lint step. */
      lint: z.string().min(1).optional(),
      typecheck: z.string().min(1).default(pnpm.typecheck),
      test: z.string().min(1).default(pnpm.test),
      /** Which runner `test` starts; the factory adds that runner's flags for changed files and a JSON report. */
      testRunner: z.enum(["vitest", "jest"]).default("vitest"),
    })
    .prefault({}),
  /**
   * How to run the app for the browser check. The factory starts the task's own version with `start` and waits for
   * `healthUrls`. It never tests an app it did not start, so without `start` a visible change escalates.
   */
  app: z
    .object({
      start: z.string().min(1).optional(),
      url: z.string().url().default("http://localhost:5173"),
      healthUrls: z.array(z.string().url()).default([]),
      startTimeoutMs: z.number().int().positive().default(300_000),
    })
    .prefault({}),
  /** Failed attempts in a row before a task escalates. */
  maxAttempts: z.number().int().positive().default(3),
  policy: RiskPolicy.default(DEFAULT_POLICY),
  tracker: TrackerConfig.default({ type: "github" }),
  /**
   * The skills each stage reads. By default the factory's own copies of Matt Pocock's skills. Set `dir` to your own
   * skills folder (absolute, or relative to the repository root), and `stages` to the files each stage reads,
   * relative to `dir`. A stage left out of `stages` keeps the default files, so they must exist in `dir` too.
   */
  skills: z
    .object({
      dir: z.string().min(1).optional(),
      stages: z
        .partialRecord(z.enum(["scoping", "design", "test_writing", "implementing", "reviewing", "pr", "planning"]), z.array(z.string().min(1)))
        .default({}),
    })
    .prefault({}),
  /**
   * Runtime verification for React UI (`factory init` copies the framework into `dir`). When on, the test phase
   * writes a `<Unit>.verify.ts` spec for each UI unit it adds or changes, the gate runs them in jsdom, and the
   * browser check opens each changed unit's fixtures in the task's app before the agent looks at the pages.
   */
  verify: z
    .object({
      enabled: z.boolean().default(false),
      /** The framework's folder, relative to `projectDir`. Specs go in `<dir>/specs/`. */
      dir: z.string().min(1).default("src/verify"),
      /** The harness page in the running app that lists every unit (`window.__verify`). */
      entry: z.string().min(1).default("/verify.html"),
    })
    .prefault({}),
  /**
   * Agents' shell commands, and the tests they start, run in Claude Code's sandbox: they can read and write their
   * own worktree only, and reach no network host except these.
   */
  sandbox: z
    .object({
      allowedDomains: z.array(z.string().min(1)).default([]),
      /** Folders outside the worktree the project's tools must read, such as a shared cache. The rest of the home folder is denied. */
      allowRead: z.array(z.string().min(1)).default([]),
    })
    .prefault({}),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

/** A ticket key in the tracker's form: "#12" for GitHub (also accepts "12"), or one that matches `keyPattern`. */
export function normalizeTicketKey(tracker: TrackerConfig, input: string): { ok: true; key: string } | { ok: false; error: string } {
  const key = input.trim();
  if (tracker.type === "github") {
    const m = /^#?(\d+)$/.exec(key);
    return m ? { ok: true, key: `#${m[1]}` } : { ok: false, error: `"${key}" is not a GitHub issue. Use a number like #12` };
  }
  if (tracker.keyPattern && !new RegExp(tracker.keyPattern).test(key)) return { ok: false, error: `"${key}" is not a ${tracker.label} ticket key (${tracker.keyPattern})` };
  return { ok: true, key };
}

