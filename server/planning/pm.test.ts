// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaudeCall, ClaudeResult } from "../claude";
import { FactoryDb } from "../db";
import type { Effects } from "../orchestrator";
import type { IssueTracker, TrackedIssue } from "./filing";
import { contentPlatformPlan, contentPlatformSpec } from "./fixtures";
import { Planner } from "./pm";

class FakeTracker implements IssueTracker {
  issues: Array<TrackedIssue & { labels: string[] }> = [];
  comments: Array<{ n: number; body: string }> = [];
  async listIssues(label: string) {
    return this.issues.filter((i) => i.labels.includes(label));
  }
  async createIssue(i: { title: string; body: string; labels: string[] }) {
    const number = 100 + this.issues.length;
    this.issues.push({ number, state: "open", ...i });
    return number;
  }
  async editIssue(n: number, i: { title?: string; body?: string }) {
    Object.assign(this.issues.find((x) => x.number === n)!, i);
  }
  async ensureLabel() {}
  async comment(n: number, body: string) {
    this.comments.push({ n, body });
  }
}

let db: FactoryDb;
let dir: string;
let tracker: FakeTracker;
let outputs: Array<(cwd: string) => unknown>;
let prompts: string[];
let pushes: number;

function effects(): Effects {
  return {
    async claude(call: ClaudeCall, opts: { cwd: string; runDir: string }): Promise<ClaudeResult> {
      prompts.push(call.prompt);
      const next = outputs.shift();
      const output = next ? next(opts.cwd) : null;
      return { ok: true, subtype: "success", costUsd: 0.5, turns: 4, sessionId: "s", output, text: "", logPath: join(opts.runDir, "stream.jsonl") };
    },
    async createWorktree() {
      const worktree = join(dir, "wt", "app");
      mkdirSync(join(worktree, "specs"), { recursive: true });
      return { branch: "factory/plan", worktree };
    },
    async commitAndPush() {
      pushes++;
    },
    async createPr() {
      return 77;
    },
  } as unknown as Effects;
}

/** The golden plan: the PM writes the content-platform spec and returns its tickets. */
const golden = (cwd: string) => {
  writeFileSync(join(cwd, "specs", "content-platform.md"), contentPlatformSpec);
  return contentPlatformPlan();
};

function planner(dryRun = false) {
  return new Planner(db, effects(), tracker, { projectDir: "app", base: "factory/main", maxAttempts: 3, artifactRoot: join(dir, "artifacts"), dryRun });
}

async function finished(id: string) {
  for (let i = 0; i < 200; i++) {
    const plan = (await db.getPlan(id))!;
    if (plan.status !== "running") return plan;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("plan did not finish");
}

beforeEach(async () => {
  db = await FactoryDb.open(":memory:");
  dir = mkdtempSync(join(tmpdir(), "factory-pm-"));
  tracker = new FakeTracker();
  outputs = [];
  prompts = [];
  pushes = 0;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the PM run", () => {
  it("files the spec and tickets, opens a PR with the plan file, and creates tasks with their blockers", async () => {
    outputs.push(golden);
    const plan = await finished(await planner().start("#20"));

    expect(plan).toMatchObject({ status: "filed", specPath: "specs/content-platform.md", prNumber: 77 });
    expect(tracker.issues).toHaveLength(11);
    expect(tracker.comments).toEqual([{ n: 20, body: expect.stringContaining(`#${plan.filing!.parent}`) }]);
    expect(pushes).toBe(1);

    const tasks = await db.listTasks();
    expect(tasks).toHaveLength(10);
    const byKey = (key: string) => tasks.find((t) => t.id === plan.tasks[key])!;
    expect(byKey("CP-03").blockedBy).toEqual([byKey("CP-02").id]);
    expect(byKey("CP-08").blockedBy.sort()).toEqual([byKey("CP-06").id, byKey("CP-07").id].sort());
    expect(byKey("CP-01").ready).toBe(true);
    expect(byKey("CP-05").ready).toBe(false);

    const runs = await db.listAgentRuns(plan.id);
    expect(runs.map((r) => r.kind).sort()).toEqual(["filing", "planning"]);
    expect(runs.find((r) => r.kind === "planning")?.model).toBe("claude-fable-5-2");
    expect(prompts[0]).toContain("gh issue view 20");
    expect(prompts[0]).toContain(".claude/skills/to-tickets/SKILL.md");
  });

  it("sends failed checks back to the PM as feedback, and files the corrected plan", async () => {
    outputs.push((cwd) => {
      const plan = golden(cwd);
      plan.tickets[0]!.criteria = [];
      return plan;
    }, golden);
    const plan = await finished(await planner().start("specs/content-platform.md"));
    expect(plan.status).toBe("filed");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("CP-01: has no acceptance criteria");
  });

  it("escalates after the attempt limit, filing nothing", async () => {
    const broken = (cwd: string) => ({ ...golden(cwd), tickets: [] });
    outputs.push(broken, broken, broken);
    const plan = await finished(await planner().start("#21"));
    expect(plan.status).toBe("escalated");
    expect(plan.error).toMatch(/failed its checks 3 times/);
    expect(tracker.issues).toEqual([]);
    expect(await db.listTasks()).toEqual([]);
  });

  it("asks the decider about questions and re-runs the PM with the answers", async () => {
    outputs.push(
      (cwd) => ({ ...golden(cwd), questions: ["One region per site?"] }),
      () => ({ summary: "ok", decisions: [{ question: "One region per site?", answer: "Yes, configured", needsHuman: false }] }),
      golden,
    );
    const plan = await finished(await planner().start("#22"));
    expect(plan.status).toBe("filed");
    expect(prompts[1]).toContain("# Phase: decider");
    expect(prompts[2]).toContain("One region per site? Decision: Yes, configured");
  });

  it("escalates when a question needs a person", async () => {
    outputs.push(
      (cwd) => ({ ...golden(cwd), questions: ["May we store reader emails?"] }),
      () => ({ summary: "", decisions: [{ question: "May we store reader emails?", answer: "", needsHuman: true }] }),
    );
    const plan = await finished(await planner().start("#23"));
    expect(plan).toMatchObject({ status: "escalated", error: expect.stringMatching(/could not settle/) });
  });

  it("writes the bodies and files nothing in dry run", async () => {
    outputs.push(golden);
    const plan = await finished(await planner(true).start("#24"));
    expect(plan.status).toBe("dry_run");
    expect(tracker.issues).toEqual([]);
    expect(await db.listTasks()).toEqual([]);
  });

  it("picks up open intake issues once", async () => {
    tracker.issues.push({ number: 30, title: "Idea", body: "", state: "open", labels: ["factory:intake"] });
    outputs.push(golden);
    const p = planner();
    const started = await p.pollIntake();
    expect(started).toHaveLength(1);
    expect(await p.pollIntake()).toEqual([]);
    expect((await finished(started[0]!)).status).toBe("filed");
  });
});
