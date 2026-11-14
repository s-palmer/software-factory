/**
 * The PM agent's ticket plan: its output schema,
 * the checks code runs before anything is filed, and the order tickets are filed in.
 * Pure: reads no files and calls nothing; the caller passes the spec text and what is already filed.
 */
import { z } from "zod";
import { PHASES, PhaseModels } from "../../shared/models";

export const TICKET_KEY = /^[A-Z]{2,6}-\d{2}$/;
export const MAX_TICKETS = 15;
export const MAX_L_CRITERIA = 8;
/** The `## ` sections every spec must have (the repository's spec template). */
export const SPEC_SECTIONS = ["Problem Statement", "Solution", "User Stories", "Implementation Decisions", "Testing Decisions", "Out of Scope"] as const;

export const TicketSize = z.enum(["S", "M", "L"]);
export type TicketSize = z.infer<typeof TicketSize>;

export const PlanTicket = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  size: TicketSize,
  blockedBy: z.array(z.string()),
  build: z.string().min(1),
  /** May be empty here; `checkPlan` reports it by key. */
  criteria: z.array(z.string().min(1)),
  /** The spec's user story numbers this ticket covers. */
  stories: z.array(z.number().int().positive()).optional(),
  phaseModels: PhaseModels.optional(),
});
export type PlanTicket = z.infer<typeof PlanTicket>;

export const PlanOutput = z.object({
  summary: z.string(),
  questions: z.array(z.string()),
  spec: z.object({ path: z.string().min(1), title: z.string().min(1) }),
  tickets: z.array(PlanTicket),
  /** Spec items left out, with the reason. "Story N: ..." marks user story N as deliberately not covered. */
  deferred: z.array(z.string()),
});
export type PlanOutput = z.infer<typeof PlanOutput>;

const str = { type: "string" } as const;
const strs = { type: "array", items: str } as const;
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });

/** For `claude --json-schema`. Stricter than `PlanOutput` where that helps the agent: `stories` is required. */
export const PLAN_JSON_SCHEMA = obj(
  {
    summary: str,
    questions: strs,
    spec: obj({ path: { type: "string", pattern: "^specs/[a-z0-9-]+\\.md$" }, title: str }, ["path", "title"]),
    tickets: {
      type: "array",
      items: obj(
        {
          key: { type: "string", pattern: TICKET_KEY.source },
          title: str,
          size: { enum: ["S", "M", "L"] },
          blockedBy: strs,
          build: str,
          criteria: strs,
          stories: { type: "array", items: { type: "integer", minimum: 1 } },
          phaseModels: obj(Object.fromEntries(PHASES.map((p) => [p, str])), []),
        },
        ["key", "title", "size", "blockedBy", "build", "criteria", "stories"],
      ),
    },
    deferred: strs,
  },
  ["summary", "questions", "spec", "tickets", "deferred"],
);

export interface PlanContext {
  /** Contents of `spec.path`, or null if the file does not exist. */
  specText: string | null;
  /** Ticket keys already filed for this spec (they may be blockers, and are not duplicates of themselves). */
  filedKeys: Set<string>;
  openIssueTitles: string[];
}

export interface PlanCheck {
  ok: boolean;
  failures: string[];
}

/** The `## ` headings of a markdown document. */
function headings(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => l.startsWith("## "))
    .map((l) => l.slice(3).trim());
}

/** The numbers of the numbered list items under `## User Stories`. */
export function userStoryNumbers(specText: string): number[] {
  const numbers: number[] = [];
  let inside = false;
  for (const line of specText.split("\n")) {
    if (line.startsWith("## ")) {
      inside = line.slice(3).trim() === "User Stories";
      continue;
    }
    const m = inside ? /^\s*(\d+)\.\s/.exec(line) : null;
    if (m?.[1]) numbers.push(Number(m[1]));
  }
  return numbers;
}

/** A title without its `KEY: ` prefix, case, punctuation or extra spaces. */
export function normaliseTitle(title: string): string {
  return title
    .replace(/^\s*[A-Z]{2,6}-\d{2}:\s*/, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The first blocker cycle among the plan's own tickets, as keys with the first repeated at the end, or null. */
export function findCycle(tickets: readonly PlanTicket[]): string[] | null {
  const byKey = new Map(tickets.map((t) => [t.key, t]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (key: string): string[] | null => {
    const s = state.get(key);
    if (s === "done") return null;
    if (s === "visiting") return [...stack.slice(stack.indexOf(key)), key];
    state.set(key, "visiting");
    stack.push(key);
    for (const b of byKey.get(key)?.blockedBy ?? []) {
      if (!byKey.has(b)) continue;
      const cycle = visit(b);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(key, "done");
    return null;
  };
  for (const t of tickets) {
    const cycle = visit(t.key);
    if (cycle) return cycle;
  }
  return null;
}

/** Checks 1–6 of the spec, in order. `plan` is the agent's raw output; a schema failure stops the other checks. */
export function checkPlan(plan: unknown, ctx: PlanContext): PlanCheck {
  const parsed = PlanOutput.safeParse(plan);
  if (!parsed.success) {
    return { ok: false, failures: parsed.error.issues.map((i) => `Schema: ${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  const p = parsed.data;
  const failures: string[] = [];

  // 1. The spec file exists with every section of the template.
  if (ctx.specText === null) {
    failures.push(`Spec file ${p.spec.path} does not exist`);
  } else {
    const found = new Set(headings(ctx.specText));
    const missing = SPEC_SECTIONS.filter((s) => !found.has(s));
    if (missing.length > 0) failures.push(`Spec ${p.spec.path} is missing sections: ${missing.join(", ")}`);
  }

  // 2. Criteria, unique and well-formed keys (the size is enforced by the schema).
  if (p.tickets.length === 0) failures.push("The plan has no tickets");
  const seen = new Set<string>();
  for (const t of p.tickets) {
    if (!TICKET_KEY.test(t.key)) failures.push(`${t.key}: key must look like ABC-01 (2–6 capital letters, a dash, two digits)`);
    if (seen.has(t.key)) failures.push(`${t.key}: key is used by more than one ticket`);
    seen.add(t.key);
    if (t.criteria.length === 0) failures.push(`${t.key}: has no acceptance criteria`);
  }

  // 3. Blockers exist; no cycles.
  for (const t of p.tickets) {
    for (const b of t.blockedBy) {
      if (b === t.key) failures.push(`${t.key}: is blocked by itself`);
      else if (!seen.has(b) && !ctx.filedKeys.has(b)) failures.push(`${t.key}: blocked by ${b}, which is not in the plan or already filed`);
    }
  }
  const cycle = findCycle(p.tickets.map((t) => ({ ...t, blockedBy: t.blockedBy.filter((b) => b !== t.key) })));
  if (cycle) failures.push(`Blocker cycle: ${cycle.join(" -> ")}`);

  // 4. Sizes.
  for (const t of p.tickets) {
    if (t.size === "L" && t.criteria.length > MAX_L_CRITERIA) {
      failures.push(`${t.key}: size L with ${t.criteria.length} criteria (more than ${MAX_L_CRITERIA}); split it`);
    }
  }
  if (p.tickets.length > MAX_TICKETS) failures.push(`The plan has ${p.tickets.length} tickets (at most ${MAX_TICKETS}); split the spec`);

  // 5. Coverage of user stories.
  if (ctx.specText !== null) {
    const stories = userStoryNumbers(ctx.specText);
    const known = new Set(stories);
    if (stories.length === 0) failures.push(`Spec ${p.spec.path} has no numbered user stories`);
    if (p.tickets.length > 0 && p.tickets.every((t) => t.stories === undefined)) {
      failures.push("Tickets do not say which user stories they cover");
    } else {
      const covered = new Set<number>();
      for (const t of p.tickets) {
        for (const n of t.stories ?? []) {
          if (!known.has(n)) failures.push(`${t.key}: lists story ${n}, which is not in the spec`);
          covered.add(n);
        }
      }
      for (const d of p.deferred) {
        const m = /^Story (\d+):/i.exec(d.trim());
        if (m?.[1]) covered.add(Number(m[1]));
      }
      const uncovered = stories.filter((n) => !covered.has(n));
      if (uncovered.length > 0) {
        failures.push(`User stories not covered by any ticket or deferred ("Story N: reason"): ${uncovered.join(", ")}`);
      }
    }
  }

  // 6. No duplicate of an open issue. Keys already filed for this spec are their own issues, not duplicates.
  const open = new Map<string, string>();
  for (const title of ctx.openIssueTitles) open.set(normaliseTitle(title), title);
  for (const t of p.tickets) {
    if (ctx.filedKeys.has(t.key)) continue;
    const match = open.get(normaliseTitle(t.title));
    if (match !== undefined) failures.push(`${t.key}: duplicates the open issue "${match}"`);
  }

  return { ok: failures.length === 0, failures };
}

/** Tickets with their blockers first, otherwise in plan order. Blockers outside the plan are ignored. Throws on a cycle. */
export function orderTickets<T extends Pick<PlanTicket, "key" | "blockedBy">>(plan: { tickets: readonly T[] }): T[] {
  const keys = new Set(plan.tickets.map((t) => t.key));
  const placed = new Set<string>();
  const remaining = [...plan.tickets];
  const ordered: T[] = [];
  while (remaining.length > 0) {
    const i = remaining.findIndex((t) => t.blockedBy.every((b) => !keys.has(b) || placed.has(b)));
    if (i === -1) throw new Error(`Blocker cycle among ${remaining.map((t) => t.key).join(", ")}`);
    const [next] = remaining.splice(i, 1);
    if (!next) break;
    ordered.push(next);
    placed.add(next.key);
  }
  return ordered;
}
