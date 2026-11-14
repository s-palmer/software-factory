// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Task } from "../shared/api";
import type { TaskStatus } from "../shared/lifecycle";
import { MODELS } from "../shared/models";
import type { FileChange, RiskPolicy } from "../shared/risk";
import type { ClaudeCall, ClaudeResult } from "./claude";
import { FactoryDb } from "./db";
import { Orchestrator, type Effects, type GateResult, type OrchestratorConfig, type PrStatus, type VerifyRun } from "./orchestrator";

const policy: RiskPolicy = { alwaysHuman: [{ pattern: "factory.config.json", reason: "Changes the policy" }], maxChangedFiles: 20, maxChangedLines: 400 };

type Phase = "scoping" | "design" | "test writing" | "implement" | "review" | "browser check" | "pull request text" | "decider";
type Out = Record<string, unknown> | { fail: string };

/** Fake effects: each agent phase answers from a script; everything else is a switch the test flips. */
class Fakes implements Effects {
  calls: Array<{ phase: Phase; model: string | undefined; prompt: string; call: ClaudeCall }> = [];
  scripts = new Map<Phase, Out[]>();
  files = new Set<string>(["src/thing.test.ts"]);
  changes: FileChange[] = [{ path: "src/thing.ts", status: "modified", added: 10, removed: 2 }];
  gates: GateResult[] = [];
  testTypes: GateResult = { ok: true, steps: [] };
  testsPassBeforeChange = false;
  /** The PR as GitHub reports it. By default CI passes and the merge agent merges once the PR is ready. */
  pr: PrStatus = { state: "OPEN", isDraft: true, headSha: "abc123", checks: "pass", failures: [], changesRequested: [], conflicting: false };
  syncResult = { upToDate: false, conflicts: [] as string[] };
  syncs = 0;
  forced: boolean[] = [];
  mergeWhenReady = true;
  ready: Array<{ pr: number; ready: boolean }> = [];
  envStarts = true;
  envAlreadyUp = false;
  envUp = false;
  envStopped: number[] = [];
  pushes = 0;
  prBodies: string[] = [];

  script(phase: Phase, ...outs: Out[]): this {
    this.scripts.set(phase, [...(this.scripts.get(phase) ?? []), ...outs]);
    return this;
  }

  async claude(call: ClaudeCall, opts: { runDir: string; cwd: string }): Promise<ClaudeResult> {
    const phase = /^# Phase: (.+)$/m.exec(call.prompt)?.[1] as Phase;
    this.calls.push({ phase, model: call.model, prompt: call.prompt, call });
    const out = (this.scripts.get(phase)?.shift() ?? DEFAULTS[phase])!;
    const logPath = join(opts.runDir, "stream.jsonl");
    if ("fail" in out) return { ok: false, subtype: String(out.fail), costUsd: 0.05, turns: 1, sessionId: "s", output: null, text: "stopped", logPath };
    // Like the Playwright server: a relative screenshot name lands in the worktree.
    for (const c of (out as { criteria?: Array<{ screenshots?: string[] }> }).criteria ?? []) {
      for (const name of c.screenshots ?? []) {
        const at = name.startsWith("/") ? name : join(opts.cwd, name);
        mkdirSync(dirname(at), { recursive: true });
        writeFileSync(at, "png");
      }
    }
    return { ok: true, subtype: "success", costUsd: 0.25, turns: 3, sessionId: "s", output: out, text: "", logPath };
  }
  async createWorktree(task: Task) {
    return { branch: `factory/${task.id.slice(0, 8)}`, worktree: `/tmp/wt/${task.id}` };
  }
  verifyCalls: Array<{ units: string[] }> = [];
  verifyResults: VerifyRun[] = [];
  async verifyInBrowser(opts: { baseUrl: string; entry: string; units: string[]; outDir: string }) {
    this.verifyCalls.push({ units: opts.units });
    const results = this.verifyResults.filter((r) => opts.units.includes(r.unit));
    return { results, missing: opts.units.filter((u) => !results.some((r) => r.unit === u)) };
  }
  baseCheckouts = 0;
  async baseCheckout() {
    this.baseCheckouts++;
    return "/tmp/wt/base";
  }
  async untrackedFiles(worktree: string) {
    return existsSync(worktree) ? readdirSync(worktree).filter((f) => !f.startsWith(".")) : [];
  }
  issuesRead: string[] = [];
  async fetchIssue(_cwd: string, key: string) {
    this.issuesRead.push(key);
    return { title: `Issue ${key} title`, body: "Issue body", url: `https://github.com/o/r/issues/${key.slice(1)}`, comments: ["alice: please hurry"] };
  }
  fileExists(_w: string, path: string) {
    return this.files.has(path);
  }
  async diff() {
    return this.changes;
  }
  async gate() {
    return this.gates.shift() ?? { ok: true, steps: [{ name: "lint", ok: true, output: "" }] };
  }
  async typecheckTests() {
    return this.testTypes;
  }
  testRuns: string[][] = [];
  async runTests(_w: string, files: string[]) {
    this.testRuns.push(files);
    return { ok: this.testsPassBeforeChange, output: this.testsPassBeforeChange ? "1 passed" : "1 failed: thing is not a function" };
  }
  async commitAndPush(_w: string, _b: string, _m: string, force?: boolean) {
    this.pushes++;
    this.forced.push(Boolean(force));
  }
  async syncWithBase() {
    this.syncs++;
    this.pr.conflicting = false;
    return this.syncResult;
  }
  async createPr(_w: string, _b: string, _t: string, body: string) {
    this.prBodies.push(body);
    return 42;
  }
  async updatePrBody(_w: string, _pr: number, body: string) {
    this.prBodies.push(body);
  }
  async prStatus(): Promise<PrStatus> {
    return { ...this.pr };
  }
  async setReady(_w: string, pr: number, ready: boolean) {
    this.ready.push({ pr, ready });
    this.pr.isDraft = !ready;
    // The merge agent (outside the factory) merges a ready PR.
    if (ready && this.mergeWhenReady) this.pr.state = "MERGED";
  }
  env = {
    start: () => {
      this.envUp = this.envStarts;
      return 4242;
    },
    isUp: async () => this.envAlreadyUp || this.envUp,
    isRunning: () => this.envStarts,
    stop: async (pid: number) => {
      this.envStopped.push(pid);
      this.envUp = false;
    },
    logTail: () => "VPN is down",
  };
}

const DEFAULTS: Record<string, Record<string, unknown>> = {
  scoping: { title: "Real title", summary: "Scoped.", solutionDoc: "docs/designs/x-solution.md", questions: [], needsBrowser: true, ticketType: "task" },
  design: {
    summary: "Designed.",
    tasksDoc: "docs/designs/x-tasks.md",
    questions: [],
    needsBrowser: true,
    browserPath: "/posts",
    browserPlan: [{ criterion: "The list shows posts", path: "/posts", steps: "open the page" }],
  },
  "test writing": { summary: "Wrote tests.", testFiles: ["src/thing.test.ts"], questions: [] },
  implement: { summary: "Implemented.", questions: [], followUps: ["Paginate later"] },
  review: { verdict: "approve", summary: "Looks right.", blocking: [] },
  "browser check": { summary: "All good.", blocked: false, criteria: [{ criterion: "The list shows posts", pass: true, evidence: "3 posts shown", screenshots: [] }] },
  "before pictures": { summary: "Captured.", criteria: [{ criterion: "The list shows posts", screenshots: [], note: "" }] },
  "pull request text": { title: "Show posts", body: "Adds the list.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)" },
  decider: { summary: "Answered.", decisions: [] },
};

let db: FactoryDb;
let fakes: Fakes;
let orch: Orchestrator;
let artifactRoot: string;
let clock: number;

function make(overrides: Partial<OrchestratorConfig> = {}) {
  orch = new Orchestrator(db, fakes, {
    artifactRoot,
    maxAttempts: 3,
    policy,
    guardScript: "/factory/server/guard.mjs",
    envStartTimeoutMs: 50,
    browserBaseUrl: "http://127.0.0.1:4321",
    browserMcp: (outputDir: string) => ({ outputDir }),
    tickMs: 1000,
    now: () => new Date(clock),
    ...overrides,
  });
}

beforeEach(async () => {
  db = await FactoryDb.open(":memory:");
  fakes = new Fakes();
  artifactRoot = mkdtempSync(join(tmpdir(), "factory-orch-"));
  clock = Date.parse("2026-11-13T12:00:00Z");
  make();
});
afterEach(() => {
  orch.stop();
  db.close();
  rmSync(artifactRoot, { recursive: true, force: true });
});

/**
 * Step one task until it reaches a stop or makes no progress (no new run, same status and context).
 * Returns the stages it passed through.
 */
async function drive(id: string, max = 40): Promise<TaskStatus[]> {
  const seen: TaskStatus[] = [];
  const snapshot = async () => JSON.stringify([await db.getTask(id), (await db.listAgentRuns(id)).length]);
  for (let i = 0; i < max; i++) {
    const before = (await db.getTask(id))!;
    seen.push(before.status);
    if (before.status === "done" || before.status === "escalated") return seen;
    const was = await snapshot();
    await orch.step(id);
    const now = JSON.parse(await snapshot()) as [Task, number];
    const then = JSON.parse(was) as [Task, number];
    if (now[1] === then[1] && now[0].status === then[0].status && JSON.stringify(now[0].context) === JSON.stringify(then[0].context)) return seen;
  }
  return seen;
}

const newTask = (input: Partial<Parameters<FactoryDb["createTask"]>[0]> = {}) => db.createTask({ title: "Show posts", description: "List the posts.", ...input });
const get = async (id: string) => (await db.getTask(id))!;

describe("happy path", () => {
  it("takes a task from backlog to a merged PR with no person involved", async () => {
    const task = await newTask({ ticketKey: "#7", title: "#7" });
    const stages = await drive(task.id);

    expect(stages).toEqual(["backlog", "scoping", "design", "test_writing", "implementing", "reviewing", "browser_check", "pr", "awaiting_merge", "awaiting_merge", "done"]);
    const done = await get(task.id);
    expect(done).toMatchObject({ title: "Real title", prNumber: 42, branch: expect.stringMatching(/^factory\//) });
    expect(done.context).toMatchObject({ lockedFiles: ["src/thing.test.ts"], risk: { level: "low" }, followUps: ["Paginate later"] });
    expect(fakes.ready).toEqual([{ pr: 42, ready: true }]);
    // The task's app for the check, then the base's app for the "before" pictures.
    expect(fakes.envStopped).toEqual([4242, 4242]);
    expect(await db.getLease("env")).toBeNull();
  });

  it("rolls agent cost up into the task and records every run", async () => {
    const task = await newTask();
    await drive(task.id);
    const runs = await db.listAgentRuns(task.id);
    expect(runs.filter((r) => r.kind === "agent").map((r) => r.stage).sort()).toEqual(
      ["browser_check", "design", "implementing", "pr", "reviewing", "scoping", "test_writing"].sort(),
    );
    expect(runs.map((r) => r.kind)).toEqual(expect.arrayContaining(["worktree", "red-check", "gate", "publish", "before"]));
    // Seven stage agents and the "before" pictures.
    expect((await get(task.id)).costUsd).toBeCloseTo(8 * 0.25);
  });

  it("writes the factory footer once, without the agent's attribution line", async () => {
    const task = await newTask({ ticketKey: "#7" });
    await drive(task.id);
    const body = fakes.prBodies[0]!;
    expect(body.match(/Generated with \[Claude Code\]/g)).toHaveLength(1);
    expect(body).toContain("## Software factory");
    expect(body).toContain("- Risk: Normal");
    expect(body).toContain("Paginate later");
  });

  it("skips the browser check when the change is not visible", async () => {
    fakes.script("design", { ...DEFAULTS.design, needsBrowser: false });
    fakes.script("scoping", { ...DEFAULTS.scoping, needsBrowser: false });
    const task = await newTask();
    expect(await drive(task.id)).not.toContain("browser_check");
  });
});

describe("tickets", () => {
  it("reads a GitHub issue once at the start and puts it in every prompt", async () => {
    const task = await newTask({ ticketKey: "#7", title: "#7" });
    await drive(task.id);
    expect(fakes.issuesRead).toEqual(["#7"]);
    expect((await get(task.id)).context.ticket).toMatchObject({ title: "Issue #7 title", comments: ["alice: please hurry"] });
    for (const c of fakes.calls.filter((call) => call.phase !== "decider")) expect(c.prompt).toContain("Issue body");
  });

  it("leaves a ticket behind MCP to the agents, with the tracker's tools", async () => {
    make({ tracker: { label: "Jira", name: "jira", server: { type: "http", url: "https://example.test/mcp" }, tools: ["getJiraIssue"], instructions: "Use getJiraIssue." } });
    const task = await newTask({ ticketKey: "LI-9", title: "LI-9" });
    await drive(task.id);
    expect(fakes.issuesRead).toEqual([]);
    const scoping = fakes.calls.find((c) => c.phase === "scoping")!;
    expect(scoping.prompt).toContain("Jira ticket LI-9. Use getJiraIssue.");
    expect(scoping.call.allowedTools).toContain("mcp__jira__getJiraIssue");
  });

  it("sandboxes agent runs to the task's worktree", async () => {
    make({ isolation: { repo: "/code/app", home: "/fh", skillsDir: "/factory/skills", allowedDomains: [], allowRead: [] } });
    const task = await newTask();
    await drive(task.id);
    const s = fakes.calls.find((c) => c.prompt.startsWith("# Phase: implement"))!.call.settings as { sandbox: { filesystem: { allowRead: string[]; denyRead: string[] } }; hooks: unknown };
    expect(s.sandbox.filesystem.allowRead).toEqual(expect.arrayContaining([`/fh/worktrees/${task.id}`, "/code/app/.git"]));
    expect(s.sandbox.filesystem.denyRead).toEqual(expect.arrayContaining(["/fh", "/code/app"]));
    expect(s.hooks).toBeDefined();
  });
});

describe("browser check screenshots", () => {
  const shots = (task: string, side: string) => db.getTaskDetail(task).then((d) => d!.artifacts.filter((a) => a.label.startsWith(side)));

  it("moves screenshots out of the worktree into the task, labelled before and after, and never commits them", async () => {
    fakes.script("browser check", {
      summary: "ok",
      blocked: false,
      criteria: [{ criterion: "The list shows posts", pass: true, evidence: "3 posts", screenshots: ["after-list.png"] }],
    });
    fakes.script("before pictures" as Phase, { summary: "ok", criteria: [{ criterion: "The list shows posts", screenshots: ["before-list.png"], note: "" }] });
    const task = await newTask();
    let committed: string[] = [];
    const commit = fakes.commitAndPush.bind(fakes);
    fakes.commitAndPush = async (w, b, m, f) => {
      committed = await fakes.untrackedFiles(w);
      return commit(w, b, m, f);
    };
    await drive(task.id);
    const worktree = (await get(task.id)).worktree!;
    expect(existsSync(join(worktree, "after-list.png"))).toBe(false);
    expect(committed.filter((f) => f.endsWith(".png"))).toEqual([]);
    const after = await shots(task.id, "AFTER");
    expect(after.map((a) => a.label)).toEqual(["AFTER: PASS: The list shows posts"]);
    expect(existsSync(join(artifactRoot, after[0]!.path))).toBe(true);
    expect((await shots(task.id, "BEFORE")).map((a) => a.label)).toEqual(["BEFORE: The list shows posts"]);
    expect(fakes.baseCheckouts).toBe(1);
    const before = fakes.calls.find((c) => c.phase === ("before pictures" as Phase))!;
    expect(before.prompt).toContain("Do not judge");
    expect((before.call.mcpServers.playwright as { outputDir: string } | undefined)?.outputDir).toMatch(/screenshots$/);
  });

  it("still moves on when the app does not start on the merge base", async () => {
    const task = await newTask();
    let starts = 0;
    const start = fakes.env.start;
    // The second start is the base: it exits at once.
    fakes.env.start = () => (++starts === 2 ? ((fakes.envStarts = false), start()) : start());
    expect(await drive(task.id)).toContain("done");
    const events = (await db.getTaskDetail(task.id))!.events.map((e) => e.type);
    expect(events).toContain("before_capture_skipped");
  });

  it("moves an image an agent left in the worktree before it commits", async () => {
    // The PR agent leaves an image in the worktree, as a browser tool might.
    const claude = fakes.claude.bind(fakes);
    fakes.claude = async (call, opts) => {
      if (call.prompt.startsWith("# Phase: pull request text")) {
        mkdirSync(opts.cwd, { recursive: true });
        writeFileSync(join(opts.cwd, "stray.png"), "png");
      }
      return claude(call, opts);
    };
    const task = await newTask();
    await drive(task.id);
    const worktree = (await get(task.id)).worktree!;
    expect(existsSync(join(worktree, "stray.png"))).toBe(false);
    expect((await shots(task.id, "Left in the worktree")).map((a) => a.label)).toEqual(["Left in the worktree: stray.png"]);
  });
});

describe("runtime verification", () => {
  const verify = { dir: "src/verify", entry: "/verify.html" };
  const spec = "src/verify/specs/CartSummary.verify.ts";
  const withSpecs = () => {
    make({ verify });
    for (const f of [spec, "src/verify/specs/index.ts"]) fakes.files.add(f);
    fakes.script("test writing", { summary: "Wrote tests.", testFiles: ["src/thing.test.ts", spec, "src/verify/specs/index.ts"], questions: [] });
  };

  it("runs new specs through the matrix test in the red check, and asks for specs in the prompts", async () => {
    withSpecs();
    fakes.verifyResults = [{ unit: "CartSummary", fixture: "empty", verdict: "PASS", failures: [], screenshot: "CartSummary--empty.png" }];
    const task = await newTask();
    await drive(task.id);
    expect(fakes.testRuns[0]).toEqual(["src/thing.test.ts", "src/verify/matrix.test.ts"]);
    expect(fakes.calls.find((c) => c.prompt.startsWith("# Phase: test writing"))!.prompt).toContain("src/verify/specs/<Unit>.verify.ts");
    const implement = fakes.calls.find((c) => c.prompt.startsWith("# Phase: implement"))!;
    expect(implement.prompt).toContain("verifyAttrs");
    expect((implement.call.settings as { permissions: { deny: string[] } }).permissions.deny).toContain("Edit(./src/verify/core/**)");
  });

  it("opens the changed units' fixtures in the browser before the agent, and keeps the screenshots", async () => {
    withSpecs();
    fakes.verifyResults = [
      { unit: "CartSummary", fixture: "two-items", verdict: "PASS", failures: [], screenshot: "CartSummary--two-items.png" },
      { unit: "CartSummary", fixture: "empty", verdict: "PASS", failures: [], screenshot: "CartSummary--empty.png" },
    ];
    const task = await newTask();
    expect(await drive(task.id)).toContain("done");
    expect(fakes.verifyCalls).toEqual([{ units: ["CartSummary"] }]);
    const detail = await get(task.id);
    expect(detail.context.verified).toEqual({ units: ["CartSummary"], passed: 2, total: 2 });
    const artifacts = (await db.getTaskDetail(task.id))!.artifacts;
    expect(artifacts.map((a) => a.label)).toEqual(expect.arrayContaining(["CartSummary / empty: PASS"]));
    expect(fakes.prBodies.at(-1)).toContain("UI units checked in the browser: CartSummary (2/2 fixtures pass)");
  });

  it("sends a unit that fails in the browser back to implement, with what failed", async () => {
    withSpecs();
    fakes.verifyResults = [{ unit: "CartSummary", fixture: "empty", verdict: "FAIL", failures: ["empty-disables-checkout: button state wrong"], screenshot: "x.png" }];
    const task = await newTask();
    const stages = await drive(task.id, 12);
    expect(stages).toEqual(expect.arrayContaining(["browser_check", "implementing"]));
    expect(stages.indexOf("implementing", stages.indexOf("browser_check"))).toBeGreaterThan(-1);
    const feedback = fakes.calls.filter((c) => c.prompt.startsWith("# Phase: implement")).at(1)?.prompt ?? "";
    expect(feedback).toContain("CartSummary / empty is FAIL: empty-disables-checkout: button state wrong");
  });
});

describe("models per phase", () => {
  it("by default: Fable for scoping, design, review and the decider; Opus for tests, implement, browser check and PR text", async () => {
    fakes.script("implement", { ...DEFAULTS.implement, questions: ["Which date format?"] });
    fakes.script("decider", { summary: "ok", decisions: [{ question: "Which date format?", answer: "ISO 8601", needsHuman: false }] });
    const task = await newTask();
    await drive(task.id);
    const model = (p: Phase) => fakes.calls.find((c) => c.phase === p)?.model;
    expect([model("scoping"), model("design"), model("review"), model("decider")]).toEqual([MODELS.fable, MODELS.fable, MODELS.fable, MODELS.fable]);
    expect([model("test writing"), model("implement"), model("browser check"), model("pull request text")]).toEqual([MODELS.opus, MODELS.opus, MODELS.opus, MODELS.opus]);
    expect((await db.listAgentRuns(task.id)).find((r) => r.stage === "scoping")?.model).toBe(MODELS.fable);
  });

  it("uses the saved factory defaults, and a task's overrides win", async () => {
    await db.setDefaultModels({ design: MODELS.opus });
    const task = await newTask({ phaseModels: { implementing: MODELS.sonnet } });
    await drive(task.id);
    const model = (p: Phase) => fakes.calls.find((c) => c.phase === p)?.model;
    expect(model("design")).toBe(MODELS.opus);
    expect(model("implement")).toBe(MODELS.sonnet);
    expect(model("scoping")).toBe(MODELS.fable);
  });
});

describe("the decider", () => {
  it("answers scoping questions, and design gets the answers", async () => {
    fakes.script("scoping", { ...DEFAULTS.scoping, questions: ["Paginate or scroll?"] });
    fakes.script("decider", { summary: "ok", decisions: [{ question: "Paginate or scroll?", answer: "Paginate, 10 per page", needsHuman: false }] });
    const task = await newTask();
    await drive(task.id);

    const decider = fakes.calls.find((c) => c.phase === "decider")!;
    expect(decider.model).toBe(MODELS.fable);
    expect(decider.call.allowedTools).not.toContain("Write");
    expect(fakes.calls.find((c) => c.phase === "design")!.prompt).toContain("Paginate or scroll? Decision: Paginate, 10 per page");
    const done = await get(task.id);
    expect(done.status).toBe("done");
    expect(done.context.decisions).toEqual([{ stage: "scoping", question: "Paginate or scroll?", answer: "Paginate, 10 per page" }]);
    expect(fakes.prBodies[0]).toContain("Decisions the decider made");
  });

  it("re-runs a later stage with the answers", async () => {
    fakes.script("implement", { ...DEFAULTS.implement, questions: ["Which date format?"] });
    fakes.script("decider", { summary: "ok", decisions: [{ question: "Which date format?", answer: "ISO 8601", needsHuman: false }] });
    const task = await newTask();
    await drive(task.id);
    const implementPrompts = fakes.calls.filter((c) => c.phase === "implement").map((c) => c.prompt);
    expect(implementPrompts).toHaveLength(2);
    expect(implementPrompts[1]).toContain("Which date format? Decision: ISO 8601");
  });

  it("escalates when a question needs a person", async () => {
    fakes.script("scoping", { ...DEFAULTS.scoping, questions: ["Can we store emails?"] });
    fakes.script("decider", { summary: "", decisions: [{ question: "Can we store emails?", answer: "", needsHuman: true }] });
    const task = await newTask();
    expect((await drive(task.id)).at(-1)).toBe("escalated");
    const t = await get(task.id);
    expect(t.context).toMatchObject({ escalatedFrom: "scoping", questions: ["Can we store emails?"] });
    expect(t.context.escalation).toMatch(/could not settle/);
  });

  it("runs only once per stage, so a loop of questions reaches a person", async () => {
    fakes.script("implement", { ...DEFAULTS.implement, questions: ["A?"] }, { ...DEFAULTS.implement, questions: ["A again?"] });
    fakes.script("decider", { summary: "ok", decisions: [{ question: "A?", answer: "yes", needsHuman: false }] });
    const task = await newTask();
    expect((await drive(task.id)).at(-1)).toBe("escalated");
    expect(fakes.calls.filter((c) => c.phase === "decider")).toHaveLength(1);
  });
});

describe("test writing checks", () => {
  it("escalates when the new tests already pass", async () => {
    fakes.testsPassBeforeChange = true;
    const task = await newTask();
    expect((await drive(task.id)).at(-1)).toBe("escalated");
    expect((await get(task.id)).context.escalation).toMatch(/pass before the change/);
  });

  it("sends type faults in new tests back to the test writer, then escalates at the limit", async () => {
    fakes.testTypes = { ok: false, steps: [{ name: "typecheck", ok: false, output: "TS2322: Type 'string' is not assignable" }] };
    const task = await newTask();
    const stages = await drive(task.id);
    expect(stages.filter((s) => s === "test_writing")).toHaveLength(3);
    expect(stages.at(-1)).toBe("escalated");
    expect(fakes.calls.filter((c) => c.phase === "test writing")[1]!.prompt).toContain("TS2322");
  });

  it("accepts no tests with a reason", async () => {
    fakes.script("test writing", { summary: "none", testFiles: [], noTestsReason: "Only a lint rule changes", questions: [] });
    const task = await newTask();
    await drive(task.id);
    expect((await get(task.id)).context).toMatchObject({ lockedFiles: [], noTestsReason: "Only a lint rule changes" });
    expect(fakes.prBodies[0]).toContain("No new unit tests: Only a lint rule changes");
  });

  it("escalates when the listed test files do not exist", async () => {
    fakes.script("test writing", { summary: "x", testFiles: ["src/missing.test.ts"], questions: [] });
    const task = await newTask();
    expect((await drive(task.id)).at(-1)).toBe("escalated");
  });
});

describe("implement and the gate", () => {
  it("loops on a failed gate with only the failing steps as feedback", async () => {
    fakes.gates.push({ ok: false, steps: [{ name: "lint", ok: true, output: "" }, { name: "typecheck", ok: false, output: "src/thing.ts(3,1): error TS2304" }] });
    const task = await newTask();
    const stages = await drive(task.id);
    expect(stages.filter((s) => s === "implementing")).toHaveLength(2);
    expect(stages.at(-1)).toBe("done");
    const second = fakes.calls.filter((c) => c.phase === "implement")[1]!.prompt;
    expect(second).toContain("`typecheck` failed");
    expect(second).not.toContain("`lint` failed");
  });

  it("escalates after the attempt limit", async () => {
    const red = { ok: false, steps: [{ name: "tests", ok: false, output: "1 failed" }] };
    fakes.gates.push(red, red, red);
    const task = await newTask();
    expect((await drive(task.id)).at(-1)).toBe("escalated");
    expect((await get(task.id)).context.escalation).toMatch(/attempt 3 of 3/);
  });

  it("locks the tests for implement with a hook, and names them in the prompt", async () => {
    const task = await newTask();
    await drive(task.id);
    const impl = fakes.calls.find((c) => c.phase === "implement")!;
    expect(impl.prompt).toContain("Locked test files");
    expect(JSON.stringify(impl.call.settings)).toContain("guard.mjs");
    expect(impl.call.disallowedTools).toEqual(expect.arrayContaining(["Bash(git push:*)", "Task", "AskUserQuestion"]));
  });

  it("sends wrong locked tests back to the test writer and skips the red check on return", async () => {
    fakes.script("implement", { ...DEFAULTS.implement, testFixes: ["The test expects 11 items, the criteria say 10"] });
    const task = await newTask();
    const stages = await drive(task.id);
    expect(stages.slice(3, 7)).toEqual(["test_writing", "implementing", "test_writing", "implementing"]);
    expect(stages.at(-1)).toBe("done");
    expect((await db.listAgentRuns(task.id)).filter((r) => r.kind === "red-check")).toHaveLength(1);
  });
});

describe("review", () => {
  it("sends blocking findings back to implement", async () => {
    fakes.script("review", { verdict: "request_changes", summary: "no", blocking: ["src/thing.ts:3 off by one"] });
    const task = await newTask();
    const stages = await drive(task.id);
    expect(stages.slice(5, 7)).toEqual(["reviewing", "implementing"]);
    expect(fakes.calls.filter((c) => c.phase === "implement")[1]!.prompt).toContain("off by one");
    expect(stages.at(-1)).toBe("done");
  });

  it("can only read", async () => {
    const task = await newTask();
    await drive(task.id);
    expect(fakes.calls.find((c) => c.phase === "review")!.call.allowedTools).not.toEqual(expect.arrayContaining(["Write"]));
  });
});

describe("browser check", () => {
  it("sends a failed criterion back to implement with the evidence", async () => {
    fakes.script("browser check", { summary: "no", blocked: false, criteria: [{ criterion: "The list shows posts", pass: false, evidence: "empty page", screenshots: [] }] });
    const task = await newTask();
    const stages = await drive(task.id);
    expect(stages.slice(6, 8)).toEqual(["browser_check", "implementing"]);
    expect(fakes.calls.filter((c) => c.phase === "implement")[1]!.prompt).toContain("empty page");
  });

  it("lets untestable criteria through and lists them in the PR", async () => {
    fakes.script("browser check", {
      summary: "partly",
      blocked: false,
      criteria: [{ criterion: "Admins see drafts", pass: false, untestable: true, evidence: "no admin user locally; covered by drafts.test.ts", screenshots: [] }],
    });
    const task = await newTask();
    expect((await drive(task.id)).at(-1)).toBe("done");
    expect(fakes.prBodies[0]).toContain("Not checked in the browser: Admins see drafts");
  });

  it("escalates when the app does not start, with the log tail, and frees the lease", async () => {
    fakes.envStarts = false;
    const task = await newTask();
    expect((await drive(task.id)).at(-1)).toBe("escalated");
    expect((await get(task.id)).context.escalation).toMatch(/did not start[\s\S]*VPN is down/);
    expect(await db.getLease("env")).toBeNull();
  });

  it("waits, and never tests an app the factory did not start", async () => {
    fakes.envAlreadyUp = true;
    const task = await newTask();
    const stages = await drive(task.id);
    expect(stages.at(-1)).toBe("browser_check");
    expect((await get(task.id)).context.envWait).toMatch(/outside the factory/);
    expect(fakes.calls.filter((c) => c.phase === "browser check")).toHaveLength(0);
    expect(await db.getLease("env")).toBeNull();
  });

  it("waits while another task holds the lease", async () => {
    const task = await newTask();
    await db.acquireLease("env", "other-task", 1);
    expect((await drive(task.id)).at(-1)).toBe("browser_check");
    expect((await get(task.id)).context.envWait).toMatch(/Another task/);
  });
});

describe("after the PR: the factory never merges", () => {
  it("marks the PR ready with its risk label once CI is green, then waits for the merge agent", async () => {
    fakes.mergeWhenReady = false;
    const task = await newTask();
    expect((await drive(task.id)).at(-1)).toBe("awaiting_merge");
    expect(fakes.ready).toEqual([{ pr: 42, ready: true }]);
    expect((await db.getTaskDetail(task.id))!.events.map((e) => e.type)).toContain("pr_ready");
    // Still open: nothing more to do. Merged by the merge agent: done.
    expect((await drive(task.id)).at(-1)).toBe("awaiting_merge");
    fakes.pr.state = "MERGED";
    expect((await drive(task.id)).at(-1)).toBe("done");
  });

  it("marks a high-risk change ready for the merge agent, with the risk in the footer and the event, and no labels", async () => {
    fakes.mergeWhenReady = false;
    fakes.changes = [{ path: "factory.config.json", status: "modified", added: 1, removed: 1 }];
    const task = await newTask();
    expect((await drive(task.id)).at(-1)).toBe("awaiting_merge");
    expect(fakes.ready).toEqual([{ pr: 42, ready: true }]);
    expect(fakes.prBodies[0]).toContain("Changes the policy");
    const ready = (await db.getTaskDetail(task.id))!.events.find((e) => e.type === "pr_ready");
    expect(ready?.payload).toMatchObject({ risk: "high" });
  });

  it("waits while CI is pending", async () => {
    fakes.pr.checks = "pending";
    const task = await newTask();
    expect((await drive(task.id)).at(-1)).toBe("awaiting_merge");
    expect(fakes.ready).toEqual([]);
    fakes.pr.checks = "pass";
    expect((await drive(task.id)).at(-1)).toBe("done");
  });

  it("sends failing checks back to implement, turns the PR back to draft, and pushes to the same PR", async () => {
    let calls = 0;
    const status = fakes.prStatus.bind(fakes);
    fakes.prStatus = async () => ({ ...(await status()), ...(calls++ === 0 ? { checks: "fail" as const, failures: ["ci / unit tests"] } : {}) });
    const task = await newTask();
    const stages = await drive(task.id);
    // Checks fail once (back to implement), then pass: marked ready, then merged.
    expect(stages.filter((s) => s === "awaiting_merge")).toHaveLength(3);
    expect(stages.at(-1)).toBe("done");
    expect(fakes.calls.filter((c) => c.phase === "implement")[1]!.prompt).toContain("ci / unit tests");
    expect(fakes.ready[0]).toMatchObject({ ready: false });
    expect(fakes.pushes).toBe(2);
    expect(fakes.prBodies).toHaveLength(2);
  });

  it("treats changes requested on the PR as a review round and unlocks the tests", async () => {
    fakes.mergeWhenReady = false;
    const task = await newTask();
    expect((await drive(task.id)).at(-1)).toBe("awaiting_merge");
    clock += 60_000;
    fakes.pr.changesRequested = [{ at: new Date(clock).toISOString(), by: "merge-agent", body: "Rename the helper" }];
    const stages = await drive(task.id);
    expect(stages[1]).toBe("implementing");
    expect(fakes.calls.filter((c) => c.phase === "implement").at(-1)!.prompt).toContain("merge-agent asked for changes on the pull request: Rename the helper");
    // The same review is not handled twice once the factory has pushed again.
    expect(stages.at(-1)).toBe("awaiting_merge");
    expect((await get(task.id)).context.lockedFiles).toEqual([]);
  });

  it("escalates when the checks keep failing: later rounds share the retry budget", async () => {
    fakes.pr.checks = "fail";
    fakes.pr.failures = ["ci / unit tests"];
    const task = await newTask();
    expect((await drive(task.id, 60)).at(-1)).toBe("escalated");
    expect(fakes.pushes).toBe(3);
  });

  it("resolves a conflict with the base: implement fixes the markers, the pipeline runs again, the push is forced", async () => {
    fakes.mergeWhenReady = false;
    const task = await newTask();
    expect((await drive(task.id)).at(-1)).toBe("awaiting_merge");
    fakes.pr.conflicting = true;
    fakes.syncResult = { upToDate: false, conflicts: ["src/thing.ts"] };
    const stages = await drive(task.id);
    expect(stages.slice(0, 3)).toEqual(["awaiting_merge", "implementing", "reviewing"]);
    expect(stages.at(-1)).toBe("awaiting_merge");
    expect(fakes.calls.filter((c) => c.phase === "implement").at(-1)!.prompt).toContain("Resolve the conflict markers in these files, keeping both sides' intent: src/thing.ts");
    expect(fakes.forced).toEqual([false, true]);
    expect((await db.listAgentRuns(task.id)).find((r) => r.kind === "sync")).toMatchObject({ status: "failed", summary: "Conflicts in src/thing.ts" });
  });

  it("moves a clean change onto the base itself: gate, forced push, back to draft until CI is green", async () => {
    fakes.mergeWhenReady = false;
    const task = await newTask();
    await drive(task.id);
    await db.updateTask(task.id, { context: { syncRequested: true } });
    const implementRuns = fakes.calls.filter((c) => c.phase === "implement").length;
    await orch.step(task.id);
    expect(fakes.syncs).toBe(1);
    expect(fakes.forced.at(-1)).toBe(true);
    expect(fakes.calls.filter((c) => c.phase === "implement")).toHaveLength(implementRuns);
    expect(fakes.ready.at(-1)).toMatchObject({ ready: false });
    expect((await get(task.id)).context.syncRequested).toBeUndefined();
    expect((await drive(task.id)).at(-1)).toBe("awaiting_merge");
    expect(fakes.ready.at(-1)).toMatchObject({ ready: true });
  });

  it("escalates when the PR is closed without a merge", async () => {
    fakes.mergeWhenReady = false;
    const task = await newTask();
    await drive(task.id);
    fakes.pr.state = "CLOSED";
    expect((await drive(task.id)).at(-1)).toBe("escalated");
    expect((await get(task.id)).context.escalation).toBe("PR #42 was closed without a merge.");
  });
});

describe("failures and the loop", () => {
  it("escalates when an agent run fails, and records why", async () => {
    fakes.script("design", { fail: "error_max_budget_usd" });
    const task = await newTask();
    expect((await drive(task.id)).at(-1)).toBe("escalated");
    expect((await get(task.id)).context).toMatchObject({ escalatedFrom: "design", escalation: expect.stringMatching(/error_max_budget_usd/) });
  });

  it("escalates when an effect throws, and closes the run", async () => {
    fakes.gate = async () => {
      throw new Error("tsc crashed");
    };
    const task = await newTask();
    expect((await drive(task.id)).at(-1)).toBe("escalated");
    expect((await get(task.id)).context.escalation).toBe("The factory failed: tsc crashed");
    expect(await db.hasRunningAgentRun(task.id)).toBe(false);
  });

  it("interleaves tasks: each tick moves the one that waited longest", async () => {
    const a = await newTask({ title: "A" });
    const b = await newTask({ title: "B" });
    await orch.tick();
    await orch.tick();
    expect([(await get(a.id)).status, (await get(b.id)).status]).toEqual(["scoping", "scoping"]);
  });

  it("starts a task only when every blocker is done, and keeps it waiting while a blocker is escalated", async () => {
    const first = await newTask({ title: "First", ticketKey: "#5" });
    const second = await newTask({ title: "Second", blockedBy: ["#5"] });
    expect((await db.getTask(second.id))).toMatchObject({ blockedBy: [first.id], ready: false });
    while (await orch.tick()) {
      expect((await get(second.id)).status).toBe("backlog");
      if ((await get(first.id)).status === "done") break;
    }
    expect((await get(first.id)).status).toBe("done");
    expect((await get(second.id)).ready).toBe(true);
    expect(await orch.nextTask()).toBe(second.id);

    const blocker = await newTask({ title: "Stuck" });
    const waiting = await newTask({ title: "Waits", blockedBy: [blocker.id] });
    await db.moveTask(blocker.id, "backlog", "escalated");
    expect(await db.taskQueue(["backlog"])).not.toContain(waiting.id);
  });

  it("takes no steps while halted", async () => {
    const task = await newTask();
    await db.setHalt({ reason: "kill switch test", by: "human" });
    expect(await orch.tick()).toBe(false);
    expect((await get(task.id)).status).toBe("backlog");
    await db.setHalt(null);
    expect(await orch.tick()).toBe(true);
  });

  it("does not touch escalated or done tasks", async () => {
    await newTask();
    const stuck = await db.createTask({ title: "x", description: "" }, "escalated");
    await db.createTask({ title: "y", description: "" }, "done");
    const ticked: string[] = [];
    while (await orch.tick()) ticked.push("t");
    expect((await get(stuck.id)).status).toBe("escalated");
  });
});
