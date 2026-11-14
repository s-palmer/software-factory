// @vitest-environment node
import { describe, expect, it } from "vitest";
import { filePlan, parseMarker, specLabel, ticketIssueBody, type IssueTracker, type TrackedIssue } from "./filing";
import { contentPlatformIssues, contentPlatformPlan, contentPlatformSpec } from "./fixtures";

type Call =
  | { op: "create"; number: number; title: string; labels: string[] }
  | { op: "edit"; number: number; title?: string; body?: string }
  | { op: "label"; name: string }
  | { op: "comment"; number: number; body: string };

/** An in-memory GitHub: issues, labels and every write in order. */
class FakeTracker implements IssueTracker {
  issues: Array<TrackedIssue & { labels: string[] }> = [];
  labels = new Set<string>();
  calls: Call[] = [];
  constructor(private next = 3) {}

  listIssues(label: string) {
    return Promise.resolve(this.issues.filter((i) => i.labels.includes(label)).map(({ number, title, body, state }) => ({ number, title, body, state })));
  }
  createIssue(i: { title: string; body: string; labels: string[] }) {
    const number = this.next++;
    this.issues.push({ number, title: i.title, body: i.body, labels: i.labels, state: "open" });
    this.calls.push({ op: "create", number, title: i.title, labels: i.labels });
    return Promise.resolve(number);
  }
  editIssue(n: number, i: { title?: string; body?: string }) {
    const issue = this.issues.find((x) => x.number === n);
    if (!issue) throw new Error(`no issue #${n}`);
    Object.assign(issue, i);
    this.calls.push({ op: "edit", number: n, ...i });
    return Promise.resolve();
  }
  ensureLabel(name: string) {
    this.labels.add(name);
    this.calls.push({ op: "label", name });
    return Promise.resolve();
  }
  comment(n: number, body: string) {
    this.calls.push({ op: "comment", number: n, body });
    return Promise.resolve();
  }
  writes() {
    return this.calls.filter((c) => c.op !== "label");
  }
}

const opts = { specText: contentPlatformSpec, projectDir: "", branch: "main" };

async function filed() {
  const tracker = new FakeTracker();
  await filePlan(contentPlatformPlan(), tracker, opts);
  tracker.calls = [];
  return tracker;
}

describe("filePlan", () => {
  it("reproduces the golden issues #3–#13 exactly", async () => {
    const tracker = new FakeTracker();
    const result = await filePlan(contentPlatformPlan(), tracker, opts);
    const golden = contentPlatformIssues();
    expect(tracker.issues.map(({ number, title, labels, body }) => ({ number, title, labels, body }))).toEqual(golden);
    expect(result.bodies.map(({ title, body }) => ({ title, body }))).toEqual(golden.map(({ title, body }) => ({ title, body })));
  });

  it("files the parent first, then the tickets in dependency order with real Blocked-by numbers", async () => {
    const tracker = new FakeTracker();
    const result = await filePlan(contentPlatformPlan(), tracker, opts);
    expect(result.parent).toBe(3);
    expect(result.tickets).toEqual({ "CP-01": 4, "CP-02": 5, "CP-03": 6, "CP-04": 7, "CP-05": 8, "CP-06": 9, "CP-07": 10, "CP-08": 11, "CP-09": 12, "CP-10": 13 });
    expect(result.created).toHaveLength(10);
    expect(result.updated).toEqual([]);
    expect(result.parentUpdated).toBe(false);

    const writes = tracker.writes();
    expect(writes.map((c) => c.op)).toEqual(["create", ...Array<string>(10).fill("create"), "edit"]);
    expect(writes[0]).toMatchObject({ number: 3, title: "Spec: regional content platform (CMS, content store, frontend)", labels: ["content-platform"] });
    expect(writes[3]).toMatchObject({ number: 6, title: "CP-03: Content server: ingest research batches into DuckDB", labels: ["factory", "ready-for-agent", "content-platform", "size:L"] });
    expect(writes[11]).toMatchObject({ op: "edit", number: 3 });
    expect([...tracker.labels].sort()).toEqual(["content-platform", "factory", "ready-for-agent", "size:L", "size:M", "size:S"]);

    const cp05 = tracker.issues.find((i) => i.number === 8)?.body ?? "";
    expect(cp05).toContain("## Blocked by\n\n- #4 Workspace and EmDash site skeleton\n- #7 Editorial checks and the content lifecycle\n");
    expect(parseMarker(cp05)).toEqual({ path: "specs/content-platform.md", key: "CP-05" });
    expect(parseMarker(tracker.issues[0]?.body ?? "")).toEqual({ path: "specs/content-platform.md", key: null });
  });

  it("builds the CP-03 body like issue #6", () => {
    const plan = contentPlatformPlan();
    const t = plan.tickets.find((x) => x.key === "CP-03");
    if (!t) throw new Error("no CP-03");
    const body = ticketIssueBody({ specPath: plan.spec.path, ticket: t, parent: 3, blockedBy: [{ ref: 5, title: "Research contract: brief, item and batch schemas" }] });
    expect(body.startsWith("<!-- factory-spec: specs/content-platform.md#CP-03 -->\n\n## Parent\n\n#3\n\n## What to build\n\nA content server")).toBe(true);
    expect(body).toContain("## Acceptance criteria\n\n- [ ] Submitting a batch returns");
    expect(body.endsWith("## Blocked by\n\n- #5 Research contract: brief, item and batch schemas\n")).toBe(true);
    expect(body).toBe(contentPlatformIssues().find((i) => i.number === 6)?.body);
  });

  it("creates and updates nothing when re-run with the same plan", async () => {
    const tracker = await filed();
    const result = await filePlan(contentPlatformPlan(), tracker, opts);
    expect(tracker.writes()).toEqual([]);
    expect(result).toMatchObject({ parent: 3, created: [], updated: [], skipped: [], removed: [], parentUpdated: false });
    expect(result.tickets["CP-10"]).toBe(13);
  });

  it("edits a changed ticket only while it is editable", async () => {
    const tracker = await filed();
    const plan = contentPlatformPlan();
    const cp07 = plan.tickets.find((t) => t.key === "CP-07");
    if (!cp07) throw new Error("no CP-07");
    cp07.criteria.push("Articles show their reading time");

    const refused = await filePlan(plan, tracker, { ...opts, editable: (k) => k !== "CP-07" });
    expect(refused).toMatchObject({ updated: [], skipped: ["CP-07"], created: [] });
    expect(tracker.writes()).toEqual([]);

    const allowed = await filePlan(plan, tracker, opts);
    expect(allowed).toMatchObject({ updated: ["CP-07"], skipped: [], created: [] });
    expect(tracker.writes()).toEqual([expect.objectContaining({ op: "edit", number: 10 })]);
    expect(tracker.issues.find((i) => i.number === 10)?.body).toContain("- [ ] Articles show their reading time\n");
  });

  it("creates a new key with blockers already filed, and lists a removed key without closing it", async () => {
    const tracker = await filed();
    const plan = contentPlatformPlan();
    plan.tickets = plan.tickets.filter((t) => t.key !== "CP-08");
    const cp10 = plan.tickets.find((t) => t.key === "CP-10");
    if (!cp10) throw new Error("no CP-10");
    cp10.blockedBy = ["CP-09"];
    plan.tickets.push({ key: "CP-11", title: "Newsletter signup", size: "S", blockedBy: ["CP-08", "CP-07"], build: "A signup form.", criteria: ["A reader can sign up"] });

    const result = await filePlan(plan, tracker, opts);
    expect(result.removed).toEqual(["CP-08"]);
    expect(result.created).toEqual(["CP-11"]);
    expect(result.updated).toEqual(["CP-10"]);
    expect(result.parentUpdated).toBe(true);
    expect(result.tickets["CP-11"]).toBe(14);
    // CP-08 is gone from the plan but still filed, so it still resolves as a blocker by its issue.
    expect(tracker.issues.find((i) => i.number === 14)?.body).toContain("## Blocked by\n\n- #11 Home page: what's on and what's new\n- #10 News pages: list and article\n");
    expect(tracker.issues.find((i) => i.number === 11)?.state).toBe("open");
    const parent = tracker.issues.find((i) => i.number === 3)?.body ?? "";
    expect(parent).not.toContain("#11 Home page");
    expect(parent).toContain("- [ ] #14 Newsletter signup (blocked by #11, #10)");
  });

  it("keeps ticked boxes in the parent checklist", async () => {
    const tracker = await filed();
    const parent = tracker.issues[0];
    if (!parent) throw new Error("no parent");
    parent.body = parent.body.replace("- [ ] #4 ", "- [x] #4 ");
    const result = await filePlan(contentPlatformPlan(), tracker, opts);
    expect(tracker.writes()).toEqual([]);
    expect(result.bodies[0]?.body).toContain("- [x] #4 Workspace");
  });

  it("makes no writes in a dry run, and returns the bodies with placeholders", async () => {
    const tracker = new FakeTracker();
    const result = await filePlan(contentPlatformPlan(), tracker, { ...opts, dryRun: true, intakeIssue: 1 });
    expect(tracker.calls).toEqual([]);
    expect(result.parent).toBeNull();
    expect(result.tickets).toEqual({});
    expect(result.created).toHaveLength(10);
    expect(result.bodies).toHaveLength(11);
    const cp03 = result.bodies.find((b) => b.key === "CP-03");
    expect(cp03?.body).toContain("## Parent\n\n#new:spec\n");
    expect(cp03?.body).toContain("- #new:CP-02 Research contract");

    const again = await filed();
    const dry = await filePlan(contentPlatformPlan(), again, { ...opts, dryRun: true });
    expect(again.calls).toEqual([]);
    expect(dry.bodies.map((b) => b.body)).toEqual(contentPlatformIssues().map((i) => i.body));
  });

  it("comments on the intake issue when it creates the parent", async () => {
    const tracker = new FakeTracker(2);
    await filePlan(contentPlatformPlan(), tracker, { ...opts, intakeIssue: 1 });
    const comments = tracker.calls.filter((c) => c.op === "comment");
    expect(comments).toEqual([{ op: "comment", number: 1, body: expect.stringContaining("#2 (Spec: regional content platform") as string }]);
    expect(comments[0]?.op === "comment" && comments[0].body).toContain("10 tickets: #3, #4");

    tracker.calls = [];
    await filePlan(contentPlatformPlan(), tracker, { ...opts, intakeIssue: 1 });
    expect(tracker.calls.filter((c) => c.op === "comment")).toEqual([]);
  });

  it("ignores issues of other specs and names the spec label after the file", async () => {
    expect(specLabel("specs/Content Platform.md")).toBe("content-platform");
    const tracker = new FakeTracker();
    tracker.issues.push({ number: 99, title: "CP-01: other", body: "<!-- factory-spec: specs/other.md#CP-01 -->\n", labels: ["content-platform"], state: "open" });
    const result = await filePlan(contentPlatformPlan(), tracker, opts);
    expect(result.created).toHaveLength(10);
    expect(result.tickets["CP-01"]).not.toBe(99);
  });
});
