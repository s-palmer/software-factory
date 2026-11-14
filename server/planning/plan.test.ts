// @vitest-environment node
import { describe, expect, it } from "vitest";
import { contentPlatformPlan, contentPlatformSpec } from "./fixtures";
import { checkPlan, findCycle, normaliseTitle, orderTickets, PLAN_JSON_SCHEMA, PlanOutput, userStoryNumbers, type PlanContext } from "./plan";

const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
  specText: contentPlatformSpec,
  filedKeys: new Set(),
  openIssueTitles: ["Fix the login page", "Spec: something else"],
  ...over,
});

function ticket(plan: PlanOutput, key: string) {
  const t = plan.tickets.find((x) => x.key === key);
  if (!t) throw new Error(`no ticket ${key}`);
  return t;
}

describe("checkPlan", () => {
  it("passes the content-platform plan", () => {
    expect(checkPlan(contentPlatformPlan(), ctx())).toEqual({ ok: true, failures: [] });
  });

  it("reports schema errors and stops there", () => {
    const plan = { ...contentPlatformPlan(), tickets: [{ key: "CP-01", size: "XL" }] };
    const r = checkPlan(plan, ctx());
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.startsWith("Schema: tickets.0.size"))).toBe(true);
    expect(r.failures.some((f) => f.startsWith("Schema: tickets.0.title"))).toBe(true);
  });

  it("reports a missing spec file and missing sections", () => {
    expect(checkPlan(contentPlatformPlan(), ctx({ specText: null })).failures).toEqual(["Spec file specs/content-platform.md does not exist"]);
    const noScope = contentPlatformSpec.replace("## Out of Scope", "## Not doing").replace("## Testing Decisions", "### Testing Decisions");
    expect(checkPlan(contentPlatformPlan(), ctx({ specText: noScope })).failures).toEqual([
      "Spec specs/content-platform.md is missing sections: Testing Decisions, Out of Scope",
    ]);
  });

  it("reports a ticket with no criteria", () => {
    const plan = contentPlatformPlan();
    ticket(plan, "CP-07").criteria = [];
    expect(checkPlan(plan, ctx()).failures).toEqual(["CP-07: has no acceptance criteria"]);
  });

  it("reports duplicate and badly formed keys", () => {
    const plan = contentPlatformPlan();
    ticket(plan, "CP-08").key = "CP-07";
    ticket(plan, "CP-02").key = "cp-2";
    ticket(plan, "CP-03").blockedBy = ["cp-2"];
    const r = checkPlan(plan, ctx());
    expect(r.failures).toContain("CP-07: key is used by more than one ticket");
    expect(r.failures).toContain("cp-2: key must look like ABC-01 (2–6 capital letters, a dash, two digits)");
  });

  it("reports an unknown blocker, but accepts one that is already filed", () => {
    const plan = contentPlatformPlan();
    ticket(plan, "CP-06").blockedBy = ["CP-01", "CP-99"];
    expect(checkPlan(plan, ctx()).failures).toEqual(["CP-06: blocked by CP-99, which is not in the plan or already filed"]);
    expect(checkPlan(plan, ctx({ filedKeys: new Set(["CP-99"]) })).ok).toBe(true);
  });

  it("reports a cycle by naming it", () => {
    const plan = contentPlatformPlan();
    ticket(plan, "CP-02").blockedBy = ["CP-04"];
    expect(checkPlan(plan, ctx()).failures).toEqual(["Blocker cycle: CP-02 -> CP-04 -> CP-03 -> CP-02"]);
  });

  it("reports a ticket blocked by itself", () => {
    const plan = contentPlatformPlan();
    ticket(plan, "CP-01").blockedBy = ["CP-01"];
    expect(checkPlan(plan, ctx()).failures).toEqual(["CP-01: is blocked by itself"]);
  });

  it("refuses an L ticket with more than eight criteria and more than 15 tickets", () => {
    const plan = contentPlatformPlan();
    const t = ticket(plan, "CP-03");
    t.criteria = [...t.criteria, "a", "b"];
    expect(checkPlan(plan, ctx()).failures).toEqual(["CP-03: size L with 9 criteria (more than 8); split it"]);

    const big = contentPlatformPlan();
    for (let i = 11; i <= 16; i++) big.tickets.push({ ...ticket(big, "CP-07"), key: `CP-${i}`, title: `Extra ${i}`, blockedBy: [] });
    expect(checkPlan(big, ctx()).failures).toEqual(["The plan has 16 tickets (at most 15); split the spec"]);
  });

  it("reports uncovered user stories, unless deferred", () => {
    const plan = contentPlatformPlan();
    ticket(plan, "CP-04").stories = [];
    ticket(plan, "CP-01").stories = [];
    expect(checkPlan(plan, ctx()).failures).toEqual(['User stories not covered by any ticket or deferred ("Story N: reason"): 13, 16']);
    plan.deferred = ["Story 13: rejections are shown by the content CLI later", "story 16: region config moves to a later spec"];
    expect(checkPlan(plan, ctx()).ok).toBe(true);
  });

  it("reports a plan whose tickets never name stories, and stories that do not exist", () => {
    const plan = contentPlatformPlan();
    for (const t of plan.tickets) delete t.stories;
    expect(checkPlan(plan, ctx()).failures).toEqual(["Tickets do not say which user stories they cover"]);

    const wrong = contentPlatformPlan();
    ticket(wrong, "CP-10").stories = [26, 27, 40];
    expect(checkPlan(wrong, ctx()).failures).toEqual(["CP-10: lists story 40, which is not in the spec"]);
  });

  it("reports a duplicate of an open issue, ignoring case, punctuation and a key prefix", () => {
    const titles = ["XY-03: news pages - list and ARTICLE!"];
    expect(checkPlan(contentPlatformPlan(), ctx({ openIssueTitles: titles })).failures).toEqual([
      'CP-07: duplicates the open issue "XY-03: news pages - list and ARTICLE!"',
    ]);
    // A ticket already filed for this spec is its own issue, not a duplicate.
    expect(checkPlan(contentPlatformPlan(), ctx({ openIssueTitles: titles, filedKeys: new Set(["CP-07"]) })).ok).toBe(true);
    expect(checkPlan(contentPlatformPlan(), ctx({ openIssueTitles: ["News pages: list and articles"] })).ok).toBe(true);
  });
});

describe("helpers", () => {
  it("reads the user story numbers of the spec", () => {
    expect(userStoryNumbers(contentPlatformSpec)).toEqual(Array.from({ length: 27 }, (_, i) => i + 1));
  });

  it("normalises titles", () => {
    expect(normaliseTitle("CP-08: Home page: what's on and what's new")).toBe("home page whats on and whats new");
  });

  it("finds no cycle in the golden plan", () => {
    expect(findCycle(contentPlatformPlan().tickets)).toBeNull();
  });

  it("orders tickets blockers first, stable otherwise", () => {
    expect(orderTickets(contentPlatformPlan()).map((t) => t.key)).toEqual(["CP-01", "CP-02", "CP-03", "CP-04", "CP-05", "CP-06", "CP-07", "CP-08", "CP-09", "CP-10"]);
    const plan = {
      tickets: [
        { key: "A-01", blockedBy: ["B-01"] },
        { key: "C-01", blockedBy: [] },
        { key: "B-01", blockedBy: ["ZZ-99"] },
      ],
    };
    expect(orderTickets(plan).map((t) => t.key)).toEqual(["C-01", "B-01", "A-01"]);
    expect(() => orderTickets({ tickets: [{ key: "A-01", blockedBy: ["A-01"] }] })).toThrow(/cycle/);
  });

  it("has a JSON schema that requires what the zod schema requires", () => {
    expect(PLAN_JSON_SCHEMA.required).toEqual(["summary", "questions", "spec", "tickets", "deferred"]);
    expect(PLAN_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(JSON.stringify(PLAN_JSON_SCHEMA)).toContain('"implementing"');
  });
});
