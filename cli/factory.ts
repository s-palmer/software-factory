/**
 * The `factory` CLI: a thin client of the factory API, built for agents first (docs/INTERFACE.md).
 *
 * - `--json` prints exactly one JSON document on stdout, also for errors (`{"error": "..."}`).
 * - Exit codes: 0 ok, 1 other/unreachable, 2 invalid input, 3 not found, 4 conflict or not allowed now, 5 refused by policy.
 * - Every request sends the actor (`FACTORY_ACTOR` or `--actor`, default "human"), which the API records and checks.
 *
 * Pure: all I/O goes through `CliIo`, so tests run it against the in-process app.
 */
import { parseArgs } from "node:util";
import { ACTOR_HEADER, ActorSchema } from "../shared/actor";
import type { DefaultModels, EnvStatus, Learning, RunDetail, Task, TaskDetail, TaskSummary, TestRun } from "../shared/api";
import { AWAITING_HUMAN, TASK_STATUSES, type TaskStatus } from "../shared/lifecycle";
import { modelPlan, PHASES, type Phase } from "../shared/models";

export interface CliIo {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  env: Record<string, string | undefined>;
  out: (text: string) => void;
  err: (text: string) => void;
}

export const EXIT = { ok: 0, failed: 1, invalid: 2, notFound: 3, conflict: 4, refused: 5 } as const;

export const DEFAULT_URL = "http://127.0.0.1:8787";

class CliError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const usageError = (message: string) => new CliError(EXIT.invalid, message);

function exitFor(status: number): number {
  if (status === 400) return EXIT.invalid;
  if (status === 403) return EXIT.refused;
  if (status === 404) return EXIT.notFound;
  if (status === 409) return EXIT.conflict;
  return EXIT.failed;
}

type Flags = {
  json: boolean;
  waiting: boolean;
  help: boolean;
  url?: string;
  actor?: string;
  title?: string;
  description?: string;
  ticket?: string;
  after?: string[];
  phase?: string[];
  gate?: string[];
  clear?: string[];
  comment?: string;
  reason?: string;
  message?: string;
  task?: string;
  since?: string;
  types?: string;
  status?: string;
};

type Api = <T>(method: string, path: string, body?: unknown) => Promise<T>;

interface Command {
  usage: string;
  summary: string;
  /** Number of positional arguments after the command name. */
  args: number;
  run: (ctx: { api: Api; args: string[]; flags: Flags }) => Promise<{ data: unknown; text: string }>;
}

const enc = encodeURIComponent;

function need(value: string | undefined, flag: string): string {
  if (!value?.trim()) throw usageError(`--${flag} is required`);
  return value;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], what: string): T {
  if (!(allowed as readonly string[]).includes(value)) throw usageError(`Unknown ${what} "${value}". Use one of: ${allowed.join(", ")}`);
  return value as T;
}

function table(rows: string[][]): string {
  if (rows.length === 0) return "";
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ")).join("\n");
}

const taskLine = (t: Task | TaskSummary) => `${t.id}  ${t.status}  ${t.ticketKey ? `${t.ticketKey} ` : ""}${t.title}`;

/** `--phase implementing=claude-opus-5-5` (repeatable) as a phase -> model map. */
function phaseModels(pairs: string[] = []): Partial<Record<Phase, string>> {
  const out: Partial<Record<Phase, string>> = {};
  for (const pair of pairs) {
    const [phase, model] = pair.split("=");
    if (!phase || !model) throw usageError(`--phase takes <phase>=<model>, for example implementing=claude-opus-5-5 (got "${pair}")`);
    out[oneOf(phase, PHASES, "phase")] = model;
  }
  return out;
}

function modelsText(defaults: Record<Phase, string>, overrides: Partial<Record<Phase, string>> = {}): string {
  const plan = modelPlan(defaults, overrides);
  return PHASES.map((p) => `  ${p.padEnd(14)} ${plan[p]}${overrides[p] ? "  (task override)" : ""}`).join("\n");
}

function decision(name: "approve" | "request_changes" | "comment", commentRequired: boolean): Command["run"] {
  return async ({ api, args, flags }) => {
    const comment = commentRequired ? need(flags.comment, "comment") : (flags.comment ?? "");
    const res = await api<{ task: Task }>("POST", `/api/tasks/${enc(args[0]!)}/feedback`, { decision: name, comment });
    return { data: res, text: `${name.replace("_", " ")}: ${taskLine(res.task)}` };
  };
}

export const COMMANDS: Record<string, Command> = {
  status: {
    usage: "status",
    summary: "Is the API up, how many tasks, how many wait for a decision",
    args: 0,
    run: async ({ api }) => {
      await api("GET", "/api/health");
      const tasks = await api<TaskSummary[]>("GET", "/api/tasks");
      const byStatus: Partial<Record<TaskStatus, number>> = {};
      for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
      const waiting = tasks.filter((t) => AWAITING_HUMAN.has(t.status)).length;
      const loop = await api<{ available: boolean; running: boolean }>("GET", "/api/orchestrator");
      const { halt } = await api<{ halt: { reason: string; by: string } | null }>("GET", "/api/control");
      const costUsd = tasks.reduce((n, t) => n + t.costUsd, 0);
      const data = { ok: true, loop, halt, tasks: tasks.length, waiting, costUsd, byStatus };
      const counts = Object.entries(byStatus).map(([s, n]) => `${s}: ${n}`).join(", ");
      const loopText = halt ? `HALTED by ${halt.by}: ${halt.reason}` : loop.available ? (loop.running ? "loop running" : "loop stopped") : "no orchestrator";
      return { data, text: `factory API up, ${loopText}. ${tasks.length} task(s), ${waiting} waiting for a person, $${costUsd.toFixed(2)} spent.${counts ? `\n${counts}` : ""}` };
    },
  },
  list: {
    usage: "list [--status <status>] [--waiting]",
    summary: "List tasks, newest first",
    args: 0,
    run: async ({ api, flags }) => {
      const status = flags.status ? oneOf(flags.status, TASK_STATUSES, "status") : undefined;
      let tasks = await api<TaskSummary[]>("GET", "/api/tasks");
      if (status) tasks = tasks.filter((t) => t.status === status);
      if (flags.waiting) tasks = tasks.filter((t) => AWAITING_HUMAN.has(t.status));
      const text = tasks.length
        ? table([
            ["ID", "STATUS", "TRIES", "COST", "TICKET", "TITLE"],
            ...tasks.map((t) => [t.id, t.status, String(t.attempts), `$${t.costUsd.toFixed(2)}`, t.ticketKey ?? "-", t.title]),
          ])
        : "No tasks.";
      return { data: tasks, text };
    },
  },
  show: {
    usage: "show <task>",
    summary: "One task with its history, feedback and artifacts",
    args: 1,
    run: async ({ api, args }) => {
      const d = await api<TaskDetail>("GET", `/api/tasks/${enc(args[0]!)}`);
      const defaults = (await api<DefaultModels>("GET", "/api/models")).phaseModels;
      const lines = [
        taskLine(d.task),
        ...(d.task.description ? ["", d.task.description] : []),
        ...(d.task.context.escalation ? ["", `Escalated from ${d.task.context.escalatedFrom ?? "?"}: ${d.task.context.escalation}`] : []),
        ...(d.task.context.questions?.length ? ["", "Open questions:", ...d.task.context.questions.map((q) => `  - ${q}`)] : []),
        ...(d.task.context.decisions?.length ? ["", "Decisions:", ...d.task.context.decisions.map((x) => `  - ${x.stage}: ${x.question} -> ${x.answer}`)] : []),
        "",
        `Attempts ${d.task.attempts}, cost $${d.task.costUsd.toFixed(2)}${d.task.branch ? `, branch ${d.task.branch}` : ""}${d.task.prNumber ? `, PR #${d.task.prNumber}` : ""}`,
        "Models:",
        modelsText(defaults, d.task.phaseModels),
        ...(d.agentRuns.length
          ? ["", "Runs:", ...d.agentRuns.map((r) => `  ${r.startedAt}  ${r.stage}/${r.kind}  ${r.status}  ${r.model ?? "-"}  $${r.costUsd.toFixed(2)}  ${r.summary ?? ""}`)]
          : []),
        "",
        "History:",
        ...d.events.map((e) => `  ${e.ts}  ${e.type}  ${JSON.stringify(e.payload)}`),
        ...(d.feedback.length ? ["", "Feedback:", ...d.feedback.map((f) => `  ${f.createdAt}  ${f.decision}  ${f.comment}`)] : []),
        ...(d.artifacts.length ? ["", "Artifacts:", ...d.artifacts.map((a) => `  ${a.kind}  ${a.label || a.path}  ${a.url}`)] : []),
      ];
      return { data: d, text: lines.join("\n") };
    },
  },
  add: {
    usage: "add (--title <title> | --ticket <#n>) [--description <text>] [--after <task or #n>]... [--phase <phase>=<model>]... [--gate scoping|design]...",
    summary: "Create a task in backlog (one per ticket); --after makes it wait until those tasks are merged; --gate stops it for a person's approval after that stage",
    args: 0,
    run: async ({ api, flags }) => {
      // A task made from a ticket alone is titled with the key; scoping copies the real title.
      const body = {
        title: flags.title?.trim() ? flags.title : need(flags.ticket, "title (or --ticket)"),
        blockedBy: flags.after ?? [],
        ...(flags.description ? { description: flags.description } : {}),
        ...(flags.ticket ? { ticketKey: flags.ticket } : {}),
        phaseModels: phaseModels(flags.phase),
        ...(flags.gate ? { gates: flags.gate } : {}),
      };
      const task = await api<Task>("POST", "/api/tasks", body);
      return { data: task, text: `created ${taskLine(task)}` };
    },
  },
  approve: { usage: "approve <task> [--comment <text>]", summary: "Retry the stage an escalated task stopped in, or approve a task at a gate", args: 1, run: decision("approve", false) },
  changes: { usage: "changes <task> --comment <text>", summary: "Send an escalated task, or a task at a gate, back with changes (comment required)", args: 1, run: decision("request_changes", true) },
  comment: { usage: "comment <task> --comment <text>", summary: "Add a comment without moving the task", args: 1, run: decision("comment", true) },
  models: {
    usage: "models <task> [--phase <phase>=<model>]... [--clear <phase>]...",
    summary: "Show or change a task's model per phase (overrides of the factory defaults)",
    args: 1,
    run: async ({ api, args, flags }) => {
      const id = enc(args[0]!);
      const change = {
        ...(flags.phase?.length ? { phaseModels: phaseModels(flags.phase) } : {}),
        ...(flags.clear?.length ? { clear: flags.clear.map((p) => oneOf(p, PHASES, "phase")) } : {}),
      };
      const task = Object.keys(change).length ? await api<Task>("PUT", `/api/tasks/${id}/models`, change) : (await api<TaskDetail>("GET", `/api/tasks/${id}`)).task;
      const defaults = (await api<DefaultModels>("GET", "/api/models")).phaseModels;
      return { data: { overrides: task.phaseModels, plan: modelPlan(defaults, task.phaseModels) }, text: modelsText(defaults, task.phaseModels) };
    },
  },
  defaults: {
    usage: "defaults [--phase <phase>=<model>]...",
    summary: "Show or change the factory's default model for each phase",
    args: 0,
    run: async ({ api, flags }) => {
      const res = flags.phase?.length
        ? await api<DefaultModels>("PUT", "/api/models", { phaseModels: phaseModels(flags.phase) })
        : await api<DefaultModels>("GET", "/api/models");
      return { data: res, text: modelsText(res.phaseModels) };
    },
  },
  plan: {
    usage: "plan <#issue | specs/file.md>",
    summary: "Start the PM agent on an idea: it writes a spec and tickets, files them as issues and creates the tasks",
    args: 1,
    run: async ({ api, args }) => {
      const res = await api<{ id: string }>("POST", "/api/plans", { source: args[0] });
      return { data: res, text: `plan ${res.id} running (factory plans, factory plan-show ${res.id})` };
    },
  },
  plans: {
    usage: "plans",
    summary: "PM runs, newest first",
    args: 0,
    run: async ({ api }) => {
      const plans = await api<Array<{ id: string; source: string; status: string; specPath: string | null; prNumber: number | null; error: string | null }>>("GET", "/api/plans");
      const text = plans.length
        ? table([["ID", "SOURCE", "STATUS", "SPEC", "PR", "ERROR"], ...plans.map((p) => [p.id, p.source, p.status, p.specPath ?? "-", p.prNumber ? `#${p.prNumber}` : "-", (p.error ?? "").slice(0, 60)])])
        : "No plans.";
      return { data: plans, text };
    },
  },
  "plan-show": {
    usage: "plan-show <plan>",
    summary: "One PM run: checks, filed issues, tasks and its agent runs",
    args: 1,
    run: async ({ api, args }) => {
      const d = await api<{ plan: Record<string, unknown> & { checks: { failures: string[] } | null; filing: { parent: number | null; tickets: Record<string, number> } | null; tasks: Record<string, string> } }>("GET", `/api/plans/${enc(args[0]!)}`);
      const p = d.plan;
      const lines = [
        `${String(p.id)}  ${String(p.source)}  ${String(p.status)}`,
        ...(p.error ? [`Error: ${String(p.error)}`] : []),
        ...(p.checks?.failures.length ? ["Check failures:", ...p.checks.failures.map((f) => `  - ${f}`)] : []),
        ...(p.filing ? [`Parent issue #${p.filing.parent}`, ...Object.entries(p.filing.tickets).map(([k, n]) => `  ${k}  #${n}  task ${p.tasks[k] ?? "-"}`)] : []),
      ];
      return { data: d, text: lines.join("\n") };
    },
  },
  "load-plan": {
    usage: "load-plan <tickets.json>",
    summary: "Create a task for every filed ticket in a plan file, in dependency order, with its blockers",
    args: 1,
    run: async ({ api, args }) => {
      const { readFileSync } = await import("node:fs");
      let plan: { tickets: Array<{ key: string; title: string; issue?: number; blockedBy: string[]; phaseModels?: Record<string, string> }> };
      try {
        plan = JSON.parse(readFileSync(args[0]!, "utf8")) as typeof plan;
      } catch (error) {
        throw usageError(`Cannot read ${args[0]}: ${(error as Error).message}`);
      }
      const issueOf = new Map(plan.tickets.map((t) => [t.key, t.issue]));
      const done = new Set<string>();
      const created: Array<{ key: string; ticket: string; id: string | null; status: "created" | "exists" }> = [];
      // Blockers first, so each task names tasks that already exist.
      while (done.size < plan.tickets.length) {
        const next = plan.tickets.find((t) => !done.has(t.key) && t.blockedBy.every((b) => done.has(b) || !issueOf.has(b)));
        if (!next) throw usageError("The plan's blockers form a cycle");
        done.add(next.key);
        if (!next.issue) throw usageError(`${next.key} has no issue number; file the plan first`);
        const ticket = `#${next.issue}`;
        const blockedBy = next.blockedBy.map((k) => issueOf.get(k)).filter((n): n is number => Boolean(n)).map((n) => `#${n}`);
        try {
          const task = await api<Task>("POST", "/api/tasks", { title: ticket, ticketKey: ticket, blockedBy, phaseModels: next.phaseModels ?? {} });
          created.push({ key: next.key, ticket, id: task.id, status: "created" });
        } catch (error) {
          if (!(error instanceof CliError) || error.code !== EXIT.conflict) throw error;
          created.push({ key: next.key, ticket, id: null, status: "exists" });
        }
      }
      const text = created.map((c) => `${c.key}  ${c.ticket}  ${c.status === "created" ? `created ${c.id}` : "already a task"}`).join("\n");
      return { data: created, text };
    },
  },
  events: {
    usage: "events [--since <cursor>] [--types a,b]",
    summary: "Events after a cursor, oldest first; the output's cursor is the --since for the next call",
    args: 0,
    run: async ({ api, flags }) => {
      const since = flags.since ?? "0";
      if (!/^\d+$/.test(since)) throw usageError("--since takes an event id (the last cursor)");
      const query = `since=${since}${flags.types ? `&types=${enc(flags.types)}` : ""}`;
      const res = await api<{ events: Array<{ id: number; ts: string; ticketKey: string | null; taskId: string | null; type: string; payload: Record<string, unknown> }>; cursor: number }>("GET", `/api/events?${query}`);
      const text = [
        ...res.events.map((e) => `${e.id}  ${e.ts}  ${e.ticketKey ?? e.taskId ?? "-"}  ${e.type}  ${JSON.stringify(e.payload)}`),
        `cursor ${res.cursor}`,
      ].join("\n");
      return { data: res, text };
    },
  },
  halt: {
    usage: "halt --reason <text>",
    summary: "Kill switch: stop the loop and the conductor (only a person can resume)",
    args: 0,
    run: async ({ api, flags }) => {
      const res = await api<{ halt: unknown }>("PUT", "/api/control", { halted: true, reason: need(flags.reason, "reason") });
      return { data: res, text: "factory halted" };
    },
  },
  resume: {
    usage: "resume",
    summary: "Lift a halt (a person only)",
    args: 0,
    run: async ({ api }) => {
      const res = await api<{ halt: unknown }>("PUT", "/api/control", { halted: false });
      return { data: res, text: "factory resumed" };
    },
  },
  notify: {
    usage: "notify --message <text> [--task <task>]",
    summary: "Hand something to a person",
    args: 0,
    run: async ({ api, flags }) => {
      const res = await api<{ ok: boolean }>("POST", "/api/notifications", { message: need(flags.message, "message"), ...(flags.task ? { taskId: flags.task } : {}) });
      return { data: res, text: "notified" };
    },
  },
  notifications: {
    usage: "notifications",
    summary: "Messages for people, newest first",
    args: 0,
    run: async ({ api }) => {
      const list = await api<Array<{ ts: string; by: string; taskId: string | null; message: string }>>("GET", "/api/notifications");
      return { data: list, text: list.length ? list.map((n) => `${n.ts}  ${n.by}${n.taskId ? `  task ${n.taskId}` : ""}  ${n.message}`).join("\n") : "No notifications." };
    },
  },
  sync: {
    usage: "sync <task>",
    summary: "Ask the factory to move a PR's change onto the latest base and resolve conflicts (for a merge agent)",
    args: 1,
    run: async ({ api, args }) => {
      const res = await api<{ ok: boolean }>("POST", `/api/tasks/${enc(args[0]!)}/sync`);
      return { data: res, text: "sync requested; the factory moves the change onto the base on its next step" };
    },
  },
  step: {
    usage: "step <task>",
    summary: "Run one step of a task now, beside the loop",
    args: 1,
    run: async ({ api, args }) => {
      const res = await api<{ status: string }>("POST", `/api/tasks/${enc(args[0]!)}/step`);
      return { data: res, text: `stepping ${args[0]} (was ${res.status})` };
    },
  },
  start: {
    usage: "start",
    summary: "Start the orchestrator loop",
    args: 0,
    run: async ({ api }) => {
      const res = await api<{ running: boolean }>("PUT", "/api/orchestrator", { running: true });
      return { data: res, text: res.running ? "loop running" : "loop stopped" };
    },
  },
  stop: {
    usage: "stop",
    summary: "Pause the orchestrator loop (a step in progress finishes)",
    args: 0,
    run: async ({ api }) => {
      const res = await api<{ running: boolean }>("PUT", "/api/orchestrator", { running: false });
      return { data: res, text: res.running ? "loop running" : "loop stopped" };
    },
  },
  runs: {
    usage: "runs",
    summary: "Recent runs, newest first",
    args: 0,
    run: async ({ api }) => {
      const runs = await api<TestRun[]>("GET", "/api/runs");
      const text = runs.length
        ? table([["ID", "STATUS", "TASK", "STARTED"], ...runs.map((r) => [r.id, r.status, r.taskId ?? "-", r.startedAt])])
        : "No runs.";
      return { data: runs, text };
    },
  },
  run: {
    usage: "run <run>",
    summary: "One run with its results and log tail",
    args: 1,
    run: async ({ api, args }) => {
      const d = await api<RunDetail>("GET", `/api/runs/${enc(args[0]!)}`);
      const lines = [
        `${d.run.id}  ${d.run.status}  task ${d.run.taskId ?? "-"}`,
        ...d.results.map((r) => `  ${r.status.padEnd(7)}  ${r.title}${r.error ? `\n           ${r.error.split("\n")[0]}` : ""}`),
        ...(d.log ? ["", d.log] : []),
      ];
      return { data: d, text: lines.join("\n") };
    },
  },
  learnings: {
    usage: "learnings",
    summary: "The retro's learnings: proposed, approved and applied",
    args: 0,
    run: async ({ api }) => {
      const learnings = await api<Learning[]>("GET", "/api/learnings");
      const state = (l: Learning) => (l.appliedAt ? `applied (${l.appliedTo})` : l.status);
      const text = learnings.length
        ? table([["ID", "KIND", "STATE", "LEARNING"], ...learnings.map((l) => [l.id.slice(0, 8), l.kind === "codebase" ? `codebase: ${l.target}` : "factory", state(l), l.summary.slice(0, 90)])])
        : "No learnings.";
      return { data: learnings, text };
    },
  },
  "learning-approve": {
    usage: "learning-approve <learning>",
    summary: "Approve a proposed learning (a person only)",
    args: 1,
    run: async ({ api, args }) => {
      const l = await api<Learning>("PATCH", `/api/learnings/${enc(await learningId(api, args[0]!))}`, { status: "approved" });
      return { data: l, text: `approved: ${l.summary}` };
    },
  },
  "learning-reject": {
    usage: "learning-reject <learning>",
    summary: "Reject a proposed learning (a person only)",
    args: 1,
    run: async ({ api, args }) => {
      const l = await api<Learning>("PATCH", `/api/learnings/${enc(await learningId(api, args[0]!))}`, { status: "rejected" });
      return { data: l, text: `rejected: ${l.summary}` };
    },
  },
  "learnings-apply": {
    usage: "learnings-apply",
    summary: "Apply approved learnings: factory ones to the learnings file, codebase ones as new tasks (a person only)",
    args: 0,
    run: async ({ api }) => {
      const r = await api<{ factory: number; tasks: Array<{ learningId: string; taskId: string }> }>("POST", "/api/learnings/apply");
      return { data: r, text: `${r.factory} added to the learnings file; ${r.tasks.length} task(s) created${r.tasks.length ? `: ${r.tasks.map((t) => t.taskId).join(", ")}` : ""}` };
    },
  },
  env: {
    usage: "env",
    summary: "The local environment for the browser check: who holds it, who waits, the end of its log",
    args: 0,
    run: async ({ api }) => {
      const s = await api<EnvStatus>("GET", "/api/env");
      const holder = !s.lease
        ? s.external
          ? `running outside the factory${s.portHolders.length ? `: ${s.portHolders.map((p) => `${p.command} (pid ${p.pid}, port ${p.port})`).join(", ")}` : ""}`
          : "free"
        : s.lease.holder === "task"
          ? `held by task ${s.lease.taskId}${s.lease.ticketKey ? ` (${s.lease.ticketKey})` : ""} ${s.lease.title ?? ""}, since ${s.lease.acquiredAt}`
          : `held by a person since ${s.lease.acquiredAt}`;
      const lines = [
        `${s.up ? "up" : "down"}, ${holder}`,
        `start: ${s.command ?? "(none: set app.start in factory.config.json)"}  url: ${s.url}`,
        ...s.waiting.map((w) => `waiting: ${w.taskId} ${w.ticketKey ?? ""} ${w.title}: ${w.reason}`),
        ...(s.log ? ["", s.log] : []),
      ];
      return { data: s, text: lines.join("\n") };
    },
  },
  "env-start": {
    usage: "env-start",
    summary: "Start the app from the repository checkout, for a person (not while a task holds it)",
    args: 0,
    run: async ({ api }) => {
      const r = await api<{ ok: boolean; message: string }>("POST", "/api/env/start");
      return { data: r, text: r.message };
    },
  },
  "env-stop": {
    usage: "env-stop",
    summary: "Stop the app a person started",
    args: 0,
    run: async ({ api }) => {
      const r = await api<{ ok: boolean; message: string }>("POST", "/api/env/stop");
      return { data: r, text: r.message };
    },
  },
  policy: {
    usage: "policy",
    summary: "The risk policy: what always needs a person",
    args: 0,
    run: async ({ api }) => {
      const policy = await api<unknown>("GET", "/api/policy");
      return { data: policy, text: JSON.stringify(policy, null, 2) };
    },
  },
};

/** A learning by its full id or the first characters of it, as `factory learnings` shows. */
async function learningId(api: Api, given: string): Promise<string> {
  const matches = (await api<Learning[]>("GET", "/api/learnings")).filter((l) => l.id.startsWith(given));
  if (matches.length !== 1) throw new CliError(matches.length ? EXIT.invalid : EXIT.notFound, matches.length ? `"${given}" matches ${matches.length} learnings` : `No learning "${given}"`);
  return matches[0]!.id;
}

export function helpText(): string {
  const rows = Object.values(COMMANDS).map((c) => [`  factory ${c.usage}`, c.summary]);
  return [
    "Usage: factory <command> [options]",
    "",
    table([["  factory init [--yes] [--tracker github|jira|linear] [--[no-]verify] [--repo <dir>] [--force]", "Set up a repository: ask a few questions, write factory.config.json, check what is missing"], ...rows]),
    "",
    "Options for every command:",
    "  --json            print one JSON document (also for errors)",
    `  --url <url>       factory API (env FACTORY_URL, default ${DEFAULT_URL})`,
    '  --actor <actor>   "human" or "agent:<name>" (env FACTORY_ACTOR, default human)',
    "",
    "Exit codes: 0 ok, 1 failed or unreachable, 2 invalid input, 3 not found, 4 conflict or not allowed now, 5 refused by policy.",
  ].join("\n");
}

function parse(argv: string[]): { positionals: string[]; flags: Flags } {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean", default: false },
        waiting: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        url: { type: "string" },
        actor: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        ticket: { type: "string" },
        after: { type: "string", multiple: true },
        phase: { type: "string", multiple: true },
        gate: { type: "string", multiple: true },
        clear: { type: "string", multiple: true },
        comment: { type: "string" },
        reason: { type: "string" },
        message: { type: "string" },
        task: { type: "string" },
        since: { type: "string" },
        types: { type: "string" },
        status: { type: "string" },
      },
    });
    return { positionals, flags: values as Flags };
  } catch (error) {
    throw usageError((error as Error).message);
  }
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const json = argv.includes("--json");
  const fail = (code: number, message: string): number => {
    if (json) io.out(JSON.stringify({ error: message }));
    else io.err(`factory: ${message}`);
    return code;
  };

  try {
    const { positionals, flags } = parse(argv);
    const [name, ...args] = positionals;
    if (!name || name === "help" || flags.help) {
      if (json) io.out(JSON.stringify({ commands: Object.values(COMMANDS).map(({ usage, summary }) => ({ usage, summary })) }));
      else io.out(helpText());
      return name || flags.help ? EXIT.ok : EXIT.invalid;
    }
    const command = COMMANDS[name];
    if (!command) throw usageError(`Unknown command "${name}". Run "factory help".`);
    if (args.length !== command.args) throw usageError(`Usage: factory ${command.usage}`);

    const actor = ActorSchema.safeParse(flags.actor ?? io.env.FACTORY_ACTOR ?? "human");
    if (!actor.success) throw usageError(actor.error.issues[0]?.message ?? "Invalid actor");
    const base = (flags.url ?? io.env.FACTORY_URL ?? DEFAULT_URL).replace(/\/+$/, "");

    const api: Api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      let res: Response;
      try {
        res = await io.fetch(`${base}${path}`, {
          method,
          headers: { [ACTOR_HEADER]: actor.data, ...(body === undefined ? {} : { "content-type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        throw new CliError(EXIT.failed, `Could not reach the factory API at ${base}: ${(error as Error).message}`);
      }
      const payload = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new CliError(exitFor(res.status), payload?.error ?? `HTTP ${res.status}`);
      return payload as T;
    };

    const result = await command.run({ api, args, flags });
    io.out(json ? JSON.stringify(result.data) : result.text);
    return EXIT.ok;
  } catch (error) {
    if (error instanceof CliError) return fail(error.code, error.message);
    return fail(EXIT.failed, (error as Error).message);
  }
}
