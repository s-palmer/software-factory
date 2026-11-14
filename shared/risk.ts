/**
 * Deterministic risk check. No LLM: a change is high risk if it touches a path that
 * always needs a human, deletes tests, or is too big. A high-risk change is never merged by the factory:
 * the task escalates so a person merges it.
 */
import { z } from "zod";

export const RiskPolicy = z.object({
  alwaysHuman: z.array(z.object({ pattern: z.string().min(1), reason: z.string().min(1) })),
  maxChangedFiles: z.number().int().positive(),
  maxChangedLines: z.number().int().positive(),
});
export type RiskPolicy = z.infer<typeof RiskPolicy>;

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted";
  added: number;
  removed: number;
}

export interface RiskResult {
  level: "low" | "high";
  reasons: string[];
}

const TEST_FILE = /(^|\/)(e2e\/|__tests__\/)|\.(test|spec|verify)\.[cm]?[jt]sx?$/;

/** Glob → RegExp. Supports `**` (any directories), `*` (within one segment), `?`. Paths use `/`. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      // "**/" matches zero or more directories; a trailing "**" matches everything below.
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function matchesGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(path.replace(/^\.\//, ""));
}

/**
 * `lockedFiles`: tests the factory's own test phase wrote and locked. Adding or changing them does not
 * count as touching protected test paths; deleting one still counts.
 */
export function classifyRisk(changes: FileChange[], policy: RiskPolicy, opts: { lockedFiles?: readonly string[] } = {}): RiskResult {
  const reasons: string[] = [];
  const locked = new Set(opts.lockedFiles ?? []);
  const judged = changes.filter((c) => c.status === "deleted" || !locked.has(c.path));
  for (const rule of policy.alwaysHuman) {
    const hits = judged.filter((c) => matchesGlob(c.path, rule.pattern)).map((c) => c.path);
    if (hits.length > 0) reasons.push(`${rule.reason}: ${hits.join(", ")}`);
  }
  const deletedTests = changes.filter((c) => c.status === "deleted" && TEST_FILE.test(c.path)).map((c) => c.path);
  if (deletedTests.length > 0) reasons.push(`Deletes tests: ${deletedTests.join(", ")}`);
  if (changes.length > policy.maxChangedFiles) reasons.push(`Changes ${changes.length} files (limit ${policy.maxChangedFiles})`);
  const lines = changes.reduce((n, c) => n + c.added + c.removed, 0);
  if (lines > policy.maxChangedLines) reasons.push(`Changes ${lines} lines (limit ${policy.maxChangedLines})`);
  return { level: reasons.length > 0 ? "high" : "low", reasons };
}
