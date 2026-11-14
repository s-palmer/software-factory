import { describe, expect, it } from "vitest";
import { afterDecision, afterFailure, afterSuccess, FACTORY_STAGES, PIPELINE, TASK_STATUSES, pipelineFor, pipelinePosition, AWAITING_HUMAN } from "./lifecycle";

describe("pipeline", () => {
  it("covers every status exactly once (the two stops for a person aside)", () => {
    expect(PIPELINE.map((s) => s.status)).toEqual(TASK_STATUSES.filter((s) => !AWAITING_HUMAN.has(s)));
  });

  it("at a gate: approve goes on to the next stage, changes run the gated stage again", () => {
    expect(afterDecision("awaiting_approval", "approve", "scoping")).toBe("design");
    expect(afterDecision("awaiting_approval", "approve", "design")).toBe("test_writing");
    expect(afterDecision("awaiting_approval", "request_changes", "design")).toBe("design");
    expect(afterDecision("awaiting_approval", "approve", "implementing")).toBeNull();
    expect(afterDecision("awaiting_approval", "approve", null)).toBeNull();
  });

  it("has no human gates", () => {
    expect(PIPELINE.map((s) => s.actor).filter((a) => a !== "agent" && a !== "system")).toEqual([]);
  });

  it("knows what's next, and leaves out the browser check for changes that are not visible", () => {
    expect(pipelinePosition("implementing")).toMatchObject({ index: 4, total: 10, next: { status: "reviewing" } });
    expect(pipelinePosition("reviewing", { needsBrowser: false })).toMatchObject({ total: 9, next: { status: "pr" } });
    expect(pipelineFor({ needsBrowser: false, current: "browser_check" }).map((s) => s.status)).toContain("browser_check");
    expect(pipelinePosition("done").next).toBeNull();
    expect(pipelinePosition("escalated")).toMatchObject({ index: -1, stage: { label: "Escalated" } });
  });
});

describe("transitions", () => {
  it("walks the happy path from backlog to done", () => {
    const path: string[] = ["backlog"];
    let stage = path[0] as (typeof TASK_STATUSES)[number];
    while (stage !== "done") path.push((stage = afterSuccess(stage, { needsBrowser: true })));
    expect(path).toEqual(PIPELINE.map((s) => s.status));
    expect(afterSuccess("reviewing", { needsBrowser: false })).toBe("pr");
  });

  it("loops fixable failures back to the stage that can fix them, and escalates at the limit", () => {
    expect(afterFailure("test_writing", 1, 3)).toBe("test_writing");
    expect(afterFailure("reviewing", 1, 3)).toBe("implementing");
    expect(afterFailure("browser_check", 2, 3)).toBe("implementing");
    expect(afterFailure("implementing", 3, 3)).toBe("escalated");
    expect(afterFailure("scoping", 1, 3)).toBe("escalated");
  });

  it("takes decisions only on escalated tasks", () => {
    for (const s of FACTORY_STAGES) expect(afterDecision(s, "approve", null)).toBeNull();
    expect(afterDecision("implementing", "comment", null)).toBe("implementing");
    expect(afterDecision("escalated", "approve", "browser_check")).toBe("browser_check");
    expect(afterDecision("escalated", "request_changes", "reviewing")).toBe("implementing");
    expect(afterDecision("escalated", "request_changes", "design")).toBe("design");
    expect(afterDecision("escalated", "approve", null)).toBe("backlog");
  });
});
