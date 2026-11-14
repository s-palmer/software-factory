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
    })
    .prefault({}),
  /** How to run the app for the browser check. Without `start`, the factory expects the app to be running at `url`. */
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
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;
