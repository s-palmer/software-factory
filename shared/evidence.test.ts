import { describe, expect, it } from "vitest";
import type { Artifact } from "./api";
import { isEvidence, pairScreenshots, parseEvidenceLabel } from "./evidence";

const shot = (id: string, run: string, label: string, createdAt: string): Artifact => ({ id, taskId: "t", kind: "screenshot", path: `tasks/t/${run}/screenshots/${id}.png`, url: `/artifacts/${id}`, label, createdAt });

describe("before and after evidence", () => {
  it("reads the labels", () => {
    expect(parseEvidenceLabel("AFTER: PASS: The drawer closes")).toEqual({ side: "AFTER", pass: true, criterion: "The drawer closes" });
    expect(parseEvidenceLabel("BEFORE: The drawer closes")).toEqual({ side: "BEFORE", pass: null, criterion: "The drawer closes" });
    expect(parseEvidenceLabel("CartSummary / empty: PASS")).toBeNull();
  });

  it("pairs each criterion's latest before and after, failures first", () => {
    const rows = pairScreenshots([
      shot("old", "r0", "AFTER: FAIL: A", "2026-11-14T10:00:00"),
      shot("a1", "r1", "AFTER: PASS: A", "2026-11-14T11:00:00"),
      shot("a2", "r1", "AFTER: FAIL: B", "2026-11-14T11:00:01"),
      shot("b1", "r2", "BEFORE: A", "2026-11-14T11:05:00"),
      shot("v", "r3", "Unit / fixture: PASS", "2026-11-14T11:06:00"),
    ]);
    expect(rows.map((r) => [r.criterion, r.pass, r.before.map((a) => a.id), r.after.map((a) => a.id)])).toEqual([
      ["B", false, [], ["a2"]],
      ["A", true, ["b1"], ["a1"]],
    ]);
  });

  it("leaves other screenshots to the gallery", () => {
    expect(isEvidence(shot("x", "r", "BEFORE: A", "2026-11-14T10:00:00"))).toBe(true);
    expect(isEvidence(shot("y", "r", "CartSummary / empty: PASS", "2026-11-14T10:00:00"))).toBe(false);
  });
});
