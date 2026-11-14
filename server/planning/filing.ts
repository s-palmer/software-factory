/**
 * Filing a checked plan as GitHub issues: the spec becomes a parent issue,
 * the tickets are filed in dependency order with "Parent" and "Blocked by" sections, and a hidden marker links each
 * issue to its spec and ticket key so a re-run updates instead of duplicating. The factory never closes an issue.
 *
 * Every GitHub call goes through `IssueTracker`, so tests use an in-memory fake. Bodies are built from fixed
 * templates; the planning fixtures hold a full example.
 */
import { orderTickets, type PlanOutput, type PlanTicket, type TicketSize } from "./plan";

export interface TrackedIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
}

export interface IssueTracker {
  /** Every issue (open and closed) with this label. */
  listIssues(label: string): Promise<TrackedIssue[]>;
  createIssue(issue: { title: string; body: string; labels: string[] }): Promise<number>;
  editIssue(number: number, issue: { title?: string; body?: string }): Promise<void>;
  /** Create the label if it does not exist. */
  ensureLabel(name: string, color: string, description: string): Promise<void>;
  comment(number: number, body: string): Promise<void>;
}

/** An issue number, or a placeholder for an issue a dry run would create. */
export type IssueRef = number | `new:${string}`;

export const FACTORY_LABELS: Record<string, { color: string; description: string }> = {
  factory: { color: "5319e7", description: "Built by the software factory" },
  "ready-for-agent": { color: "0e8a16", description: "Fully specified; an agent can pick it up" },
  "size:S": { color: "c5def5", description: "" },
  "size:M": { color: "bfd4f2", description: "" },
  "size:L": { color: "a2c4f2", description: "" },
};
export const SPEC_LABEL_COLOR = "1d76db";

/** The label named after the spec: its file name without `.md`, e.g. `content-platform`. */
export function specLabel(specPath: string): string {
  const file = specPath.split("/").pop() ?? specPath;
  return file
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function specMarker(specPath: string, key?: string): string {
  return `<!-- factory-spec: ${specPath}${key === undefined ? "" : `#${key}`} -->`;
}

/** The marker on an issue body's first line: the spec path and, for a ticket, its key. */
export function parseMarker(body: string): { path: string; key: string | null } | null {
  const m = /^\s*<!-- factory-spec: ([^#\s]+)(?:#(\S+))? -->/.exec(body);
  if (!m?.[1]) return null;
  return { path: m[1], key: m[2] ?? null };
}

export function specIssueTitle(specTitle: string): string {
  return /^spec:/i.test(specTitle) ? specTitle : `Spec: ${specTitle}`;
}

export function ticketIssueTitle(ticket: Pick<PlanTicket, "key" | "title">): string {
  return `${ticket.key}: ${ticket.title}`;
}

export function ticketLabels(specPath: string, size: TicketSize): string[] {
  return ["factory", "ready-for-agent", specLabel(specPath), `size:${size}`];
}

export interface ChecklistEntry {
  ref: IssueRef;
  title: string;
  blockedBy: IssueRef[];
  done?: boolean;
}

/** The parent issue: marker, source line, the spec without its `# ` title line, and the ticket checklist. */
export function specIssueBody(opts: { specPath: string; specText: string; projectDir: string; branch: string; tickets: ChecklistEntry[] }): string {
  const { specPath, specText, projectDir, branch, tickets } = opts;
  const text = specText.startsWith("# ") ? specText.slice(specText.indexOf("\n") + 1) : specText;
  const checklist = tickets.map((t) => {
    const blocked = t.blockedBy.length > 0 ? ` (blocked by ${t.blockedBy.map((b) => `#${b}`).join(", ")})` : "";
    return `- [${t.done ? "x" : " "}] #${t.ref} ${t.title}${blocked}`;
  });
  const source = `> Source: \`${projectDir ? `${projectDir}/` : ""}${specPath}\` on branch \`${branch}\`. Tickets are linked below.`;
  return `${specMarker(specPath)}\n\n${source}\n\n${text}\n\n## Tickets\n\n${checklist.join("\n")}\n`;
}

/** A ticket issue: marker, Parent, What to build, Acceptance criteria, Blocked by. */
export function ticketIssueBody(opts: {
  specPath: string;
  ticket: Pick<PlanTicket, "key" | "build" | "criteria">;
  parent: IssueRef;
  blockedBy: Array<{ ref: IssueRef; title: string }>;
}): string {
  const { specPath, ticket, parent, blockedBy } = opts;
  const criteria = ticket.criteria.map((c) => `- [ ] ${c}`).join("\n");
  const blocked = blockedBy.length > 0 ? blockedBy.map((b) => `- #${b.ref} ${b.title}`).join("\n") : "None (can start immediately)";
  return [
    specMarker(specPath, ticket.key),
    `## Parent\n\n#${parent}`,
    `## What to build\n\n${ticket.build}`,
    `## Acceptance criteria\n\n${criteria}`,
    `## Blocked by\n\n${blocked}\n`,
  ].join("\n\n");
}

export interface FilingOptions {
  specText: string;
  /** The project's folder in the repository, for the parent's source line (e.g. `app`, or "" for the root). */
  projectDir: string;
  branch: string;
  /** The intake issue to comment on with a link to the parent. */
  intakeIssue?: number;
  /** Compute the bodies only: no label, issue or comment is written. */
  dryRun?: boolean;
  /** Whether a filed ticket may be edited (its task is still in backlog). Default: always. */
  editable?: (key: string) => boolean;
}

export interface FiledBody {
  /** The ticket key, or null for the parent. */
  key: string | null;
  number: IssueRef;
  title: string;
  body: string;
  labels: string[];
}

export interface FilingResult {
  /** The parent issue; null only in a dry run before the spec was ever filed. */
  parent: number | null;
  /** Issue number per ticket key (in a dry run, only the ones already filed). */
  tickets: Record<string, number>;
  /** Ticket keys created by this run (or that a dry run would create). */
  created: string[];
  /** Ticket keys edited by this run (or that a dry run would edit). */
  updated: string[];
  /** Ticket keys that changed but were not edited because `editable` refused. */
  skipped: string[];
  /** Ticket keys filed before but missing from the plan: listed for a person to close, never closed. */
  removed: string[];
  /** Whether the parent's title or body was (or would be) edited. */
  parentUpdated: boolean;
  /** The bodies the plan produces, parent first, then tickets in filing order. */
  bodies: FiledBody[];
}

/** Of several issues with the same marker, the open one with the lowest number. */
function pick(current: TrackedIssue | undefined, next: TrackedIssue): TrackedIssue {
  if (!current) return next;
  if (current.state !== next.state) return current.state === "open" ? current : next;
  return next.number < current.number ? next : current;
}

/** Ticket numbers ticked in an existing parent checklist, so a re-run keeps them ticked. */
function tickedRefs(body: string | undefined): Set<string> {
  const ticked = new Set<string>();
  for (const m of (body ?? "").matchAll(/^- \[[xX]\] #(\S+) /gm)) if (m[1]) ticked.add(m[1]);
  return ticked;
}

/** File (or re-file) a checked plan. Run `checkPlan` first: this assumes unique keys and no cycles. */
export async function filePlan(plan: PlanOutput, tracker: IssueTracker, opts: FilingOptions): Promise<FilingResult> {
  const specPath = plan.spec.path;
  const label = specLabel(specPath);
  const editable = opts.editable ?? (() => true);
  const write = !opts.dryRun;

  // Existing issues by marker.
  let parentIssue: TrackedIssue | undefined;
  const filed = new Map<string, TrackedIssue>();
  for (const issue of await tracker.listIssues(label)) {
    const marker = parseMarker(issue.body);
    if (!marker || marker.path !== specPath) continue;
    if (marker.key === null) parentIssue = pick(parentIssue, issue);
    else filed.set(marker.key, pick(filed.get(marker.key), issue));
  }

  if (write) {
    const sizes = new Set(plan.tickets.map((t) => `size:${t.size}`));
    for (const name of ["factory", "ready-for-agent", ...[...sizes].sort()]) {
      const l = FACTORY_LABELS[name];
      if (l) await tracker.ensureLabel(name, l.color, l.description);
    }
    await tracker.ensureLabel(label, SPEC_LABEL_COLOR, `${plan.spec.title} (${specPath})`.slice(0, 100));
  }

  const parentTitle = specIssueTitle(plan.spec.title);
  const bodyOf = (entries: ChecklistEntry[]) => specIssueBody({ specPath, specText: opts.specText, projectDir: opts.projectDir, branch: opts.branch, tickets: entries });

  let parent: IssueRef;
  let parentCreated = false;
  if (parentIssue) parent = parentIssue.number;
  else if (write) {
    // The checklist needs the ticket numbers; it is filled in once the tickets exist.
    parent = await tracker.createIssue({ title: parentTitle, body: bodyOf([]), labels: [label] });
    parentCreated = true;
  } else parent = "new:spec";

  const result: FilingResult = {
    parent: typeof parent === "number" ? parent : null,
    tickets: {},
    created: [],
    updated: [],
    skipped: [],
    removed: [],
    parentUpdated: false,
    bodies: [],
  };
  const refs = new Map<string, IssueRef>();
  const titles = new Map<string, string>();
  for (const [key, issue] of filed) {
    refs.set(key, issue.number);
    titles.set(key, issue.title.replace(/^[A-Z]{2,6}-\d{2}:\s*/, ""));
  }
  for (const t of plan.tickets) titles.set(t.key, t.title);

  const ticketBodies: FiledBody[] = [];
  const ordered = orderTickets(plan);
  for (const ticket of ordered) {
    const title = ticketIssueTitle(ticket);
    const labels = ticketLabels(specPath, ticket.size);
    const blockedBy = ticket.blockedBy.map((b) => ({ ref: refs.get(b) ?? (`new:${b}` as const), title: titles.get(b) ?? b }));
    const body = ticketIssueBody({ specPath, ticket, parent, blockedBy });
    const existing = filed.get(ticket.key);
    let ref: IssueRef;
    if (existing) {
      ref = existing.number;
      if (existing.title !== title || existing.body !== body) {
        if (!editable(ticket.key)) result.skipped.push(ticket.key);
        else {
          if (write) await tracker.editIssue(existing.number, { title, body });
          result.updated.push(ticket.key);
        }
      }
    } else {
      ref = write ? await tracker.createIssue({ title, body, labels }) : `new:${ticket.key}`;
      result.created.push(ticket.key);
    }
    refs.set(ticket.key, ref);
    if (typeof ref === "number") result.tickets[ticket.key] = ref;
    ticketBodies.push({ key: ticket.key, number: ref, title, body, labels });
  }

  const keys = new Set(plan.tickets.map((t) => t.key));
  result.removed = [...filed.keys()].filter((k) => !keys.has(k)).sort();

  const ticked = tickedRefs(parentIssue?.body);
  const parentBody = bodyOf(
    ordered.map((t) => {
      const ref = refs.get(t.key) ?? (`new:${t.key}` as const);
      return {
        ref,
        title: t.title,
        blockedBy: t.blockedBy.map((b) => refs.get(b) ?? (`new:${b}` as const)),
        done: ticked.has(String(ref)),
      };
    }),
  );
  const parentBefore = parentIssue ?? (parentCreated ? { title: parentTitle, body: bodyOf([]) } : undefined);
  if (parentBefore && (parentBefore.title !== parentTitle || parentBefore.body !== parentBody)) {
    if (write && typeof parent === "number") await tracker.editIssue(parent, { title: parentTitle, body: parentBody });
    // A parent created by this run only gets its checklist; that is part of creating it, not an update.
    result.parentUpdated = !parentCreated;
  }
  result.bodies = [{ key: null, number: parent, title: parentTitle, body: parentBody, labels: [label] }, ...ticketBodies];

  if (write && opts.intakeIssue !== undefined && parentCreated && typeof parent === "number") {
    const list = ordered.map((t) => `#${String(refs.get(t.key))}`).join(", ");
    await tracker.comment(opts.intakeIssue, `The factory planned this as #${parent} (${parentTitle}), with ${ordered.length} tickets: ${list}.`);
  }

  return result;
}
