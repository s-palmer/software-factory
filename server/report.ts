/** Turns Playwright's JSON reporter output into the dashboard's TestResult shape. */
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AttachmentKind, RunSummary, TestAttachment, TestResult } from "../shared/api";

/** The subset of Playwright's JSON report we read. */
interface PwAttachment { name: string; contentType: string; path?: string }
interface PwResult { status: string; duration: number; attachments?: PwAttachment[]; errors?: Array<{ message?: string }>; error?: { message?: string } }
interface PwTest { status: "expected" | "unexpected" | "flaky" | "skipped"; results: PwResult[] }
interface PwSpec { title: string; file: string; tests: PwTest[] }
interface PwSuite { title: string; file?: string; specs?: PwSpec[]; suites?: PwSuite[] }
export interface PwReport { suites?: PwSuite[]; stats?: { expected?: number; unexpected?: number; flaky?: number; skipped?: number; duration?: number } }

const STATUS: Record<PwTest["status"], TestResult["status"]> = { expected: "passed", unexpected: "failed", flaky: "flaky", skipped: "skipped" };

// oxlint-disable-next-line no-control-regex -- strips ANSI colour codes from Playwright error messages
const ANSI = /\u001b\[[0-9;]*m/g;

export function artifactUrl(relPath: string): string {
  return `/artifacts/${relPath.split("/").map(encodeURIComponent).join("/")}`;
}

/** Path relative to `root`, or null if it points outside it (never serve files outside the artifact root). */
export function relativeToRoot(root: string, path: string): string | null {
  const abs = isAbsolute(path) ? path : resolve(root, path);
  const rel = relative(resolve(root), abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

function kindOf(a: PwAttachment): AttachmentKind {
  if (a.contentType.startsWith("image/")) return "screenshot";
  if (a.contentType.startsWith("video/")) return "video";
  if (a.name === "trace") return "trace";
  return "other";
}

export function parseReport(report: PwReport, artifactRoot: string): { results: TestResult[]; summary: RunSummary } {
  const results: TestResult[] = [];
  const walk = (suite: PwSuite, parents: string[]) => {
    // The top-level suite title is the file name; keep describe() titles only.
    const path = suite.file && suite.title === suite.file ? parents : [...parents, suite.title].filter(Boolean);
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        const last = test.results.at(-1);
        const attachments: TestAttachment[] = [];
        for (const a of last?.attachments ?? []) {
          const rel = a.path ? relativeToRoot(artifactRoot, a.path) : null;
          if (rel) attachments.push({ name: a.name, kind: kindOf(a), path: rel, url: artifactUrl(rel) });
        }
        const message = last?.error?.message ?? last?.errors?.[0]?.message ?? null;
        results.push({
          title: [...path, spec.title].join(" › "),
          file: spec.file,
          status: STATUS[test.status],
          durationMs: test.results.reduce((sum, r) => sum + r.duration, 0),
          error: message ? message.replace(ANSI, "") : null,
          attachments,
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, path);
  };
  for (const s of report.suites ?? []) walk(s, []);

  const stats = report.stats ?? {};
  return {
    results,
    summary: {
      passed: stats.expected ?? results.filter((r) => r.status === "passed").length,
      failed: stats.unexpected ?? results.filter((r) => r.status === "failed").length,
      flaky: stats.flaky ?? results.filter((r) => r.status === "flaky").length,
      skipped: stats.skipped ?? results.filter((r) => r.status === "skipped").length,
      durationMs: Math.round(stats.duration ?? 0),
    },
  };
}
