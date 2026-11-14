/**
 * Browser check screenshots as before-and-after evidence. Labels are "BEFORE: <criterion>" (the merge base) and
 * "AFTER: PASS|FAIL: <criterion>" (the change). Other screenshots are not evidence rows.
 */
import type { Artifact } from "./api";

export type EvidenceRow = { criterion: string; pass: boolean | null; before: Artifact[]; after: Artifact[] };

type Parsed = { side: "BEFORE" | "AFTER"; pass: boolean | null; criterion: string };

export function parseEvidenceLabel(label: string): Parsed | null {
  const m = /^(BEFORE|AFTER): (?:(PASS|FAIL): )?([\s\S]+)$/.exec(label);
  if (!m) return null;
  return { side: m[1] as Parsed["side"], pass: m[2] ? m[2] === "PASS" : null, criterion: m[3]!.trim() };
}

/**
 * One row per criterion, in the order the latest check reported them, failures first. Each side keeps only the
 * screenshots of its newest run, so an old attempt does not mix with the latest one.
 */
export function pairScreenshots(artifacts: Artifact[]): EvidenceRow[] {
  const shots = artifacts
    .filter((a) => a.kind === "screenshot")
    .flatMap((a) => {
      const label = parseEvidenceLabel(a.label);
      return label ? [{ a, label }] : [];
    });
  const newestRun = (side: Parsed["side"]) => {
    const dirs = shots.filter((s) => s.label.side === side).sort((x, y) => y.a.createdAt.localeCompare(x.a.createdAt));
    return dirs[0] ? runFolder(dirs[0].a.path) : null;
  };
  const latest = { BEFORE: newestRun("BEFORE"), AFTER: newestRun("AFTER") };
  const rows = new Map<string, EvidenceRow>();
  for (const { a, label } of shots) {
    if (runFolder(a.path) !== latest[label.side]) continue;
    const row = rows.get(label.criterion) ?? { criterion: label.criterion, pass: null, before: [], after: [] };
    if (label.side === "AFTER") {
      row.after.push(a);
      row.pass = row.pass === false ? false : label.pass;
    } else row.before.push(a);
    rows.set(label.criterion, row);
  }
  return [...rows.values()].sort((x, y) => Number(x.pass !== false) - Number(y.pass !== false));
}

/** The run folder of an artifact path such as "tasks/<task>/<run>/screenshots/x.png". */
function runFolder(path: string): string {
  return path.split("/").slice(0, 3).join("/");
}

/** Evidence screenshots, so the general gallery can leave them out. */
export const isEvidence = (a: Artifact) => a.kind === "screenshot" && parseEvidenceLabel(a.label) !== null;
