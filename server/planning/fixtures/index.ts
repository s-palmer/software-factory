/**
 * Planning fixtures: an example plan for a content platform, its spec, and the GitHub issues filing it must produce
 * (the golden issues).
 */
import { readFileSync } from "node:fs";
import { PlanOutput } from "../plan";

const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

export const contentPlatformSpec = read("./content-platform.spec.md");

/** A fresh copy each call, so tests can break it. */
export function contentPlatformPlan(): PlanOutput {
  return PlanOutput.parse(JSON.parse(read("./content-platform.plan.json")));
}

export interface GoldenIssue {
  number: number;
  title: string;
  labels: string[];
  body: string;
}

/** Issues #3 (the spec) to #13 as filed on GitHub. */
export function contentPlatformIssues(): GoldenIssue[] {
  return JSON.parse(read("./content-platform.issues.json")) as GoldenIssue[];
}
