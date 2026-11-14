/**
 * The limits of one agent run (see `Isolation` in phases.ts). Built per task: the run may read its own worktree,
 * the repository's git data (for `git diff`), the toolchain (Node, the package store, caches) and the folders the
 * project config adds. It may not read the rest of the home folder: the factory's state, other worktrees, the
 * repository checkout with its `.env` files, or other projects.
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Isolation } from "./phases";

export interface IsolationConfig {
  repo: string;
  /** The factory's state for this repository: database, artifacts, worktrees. */
  home: string;
  skillsDir: string;
  allowedDomains: string[];
  /** Extra folders the project's tools need to read, from the config. */
  allowRead: string[];
}

/** Folders under the home folder that Node, package managers and test tools read. Found once. */
let toolchain: string[] | null = null;
export function toolchainDirs(): string[] {
  if (toolchain) return toolchain;
  const home = homedir();
  const ask = (cmd: string, args: string[]) => {
    try {
      return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
    } catch {
      return "";
    }
  };
  // The folders on PATH that hold the tools, e.g. ~/.local/bin for a corepack pnpm.
  const bins = ["node", "npm", "npx", "pnpm", "yarn", "bun", "git"].map((tool) => ask("sh", ["-c", `command -v ${tool}`])).filter(Boolean).map((p) => dirname(p));
  const found = [
    dirname(dirname(process.execPath)), // the Node install, e.g. ~/.nvm/versions/node/v24
    ...bins,
    join(home, ".gitconfig"),
    join(home, ".config/git"),
    join(home, "Library/Preferences/pnpm"),
    join(home, ".config/pnpm"),
    ask("pnpm", ["store", "path"]),
    ask("npm", ["config", "get", "cache"]),
    join(home, ".cache"),
    join(home, "Library/Caches"),
    join(home, ".local/share/pnpm"),
    join(home, "Library/pnpm"),
    join(home, ".bun"),
    join(home, ".yarn"),
    join(home, ".local/share/factory/chromium-libs"),
  ];
  toolchain = [...new Set(found.filter((p) => p.startsWith(`${home}/`)))];
  return toolchain;
}

export function runIsolation(config: IsolationConfig, worktreeRoot: string): Isolation {
  return {
    denyRead: [homedir(), config.home, config.repo],
    allowRead: [worktreeRoot, join(config.repo, ".git"), config.skillsDir, ...toolchainDirs(), ...config.allowRead],
    denyWrite: [config.skillsDir],
    allowedDomains: config.allowedDomains,
  };
}
