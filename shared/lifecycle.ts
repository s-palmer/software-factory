/**
 * Task lifecycle shared by the server, the CLI and the dashboard.
 *
 * The factory runs on its own: every stage is an agent or the factory itself. It never merges: it opens a PR,
 * keeps it green, marks it ready, and a merge agent (or a person) merges it. The only stop is `escalated`,
 * where a person or an orchestrator agent (through the CLI) decides. Pure: no I/O.
 */
export const TASK_STATUSES = [
  "backlog",
  "scoping",
  "design",
  "test_writing",
  "implementing",
  "reviewing",
  "browser_check",
  "pr",
  "awaiting_merge",
  "done",
  "escalated",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Stages the orchestrator loop works on. */
export const FACTORY_STAGES: ReadonlySet<TaskStatus> = new Set([
  "backlog",
  "scoping",
  "design",
  "test_writing",
  "implementing",
  "reviewing",
  "browser_check",
  "pr",
  "awaiting_merge",
]);

/** Statuses where the pipeline waits for a decision. */
export const AWAITING_HUMAN: ReadonlySet<TaskStatus> = new Set(["escalated"]);

/** Stages in which the task's worktree holds code changes. */
const CODE_STAGES: ReadonlySet<TaskStatus> = new Set(["implementing", "reviewing", "browser_check", "pr", "awaiting_merge"]);

export function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

/** Where a stage goes when its check passes. */
export function afterSuccess(stage: TaskStatus, opts: { needsBrowser?: boolean } = {}): TaskStatus {
  switch (stage) {
    case "backlog":
      return "scoping";
    case "scoping":
      return "design";
    case "design":
      return "test_writing";
    case "test_writing":
      return "implementing";
    case "implementing":
      return "reviewing";
    case "reviewing":
      return opts.needsBrowser ? "browser_check" : "pr";
    case "browser_check":
      return "pr";
    case "pr":
      return "awaiting_merge";
    case "awaiting_merge":
      return "done";
    case "done":
    case "escalated":
      return stage;
  }
}

/**
 * Where a stage goes when its check fails, after `attempts` failures (already counted).
 * Fixable failures loop back to the stage that can fix them; at the limit, or for anything else, escalate.
 */
export function afterFailure(stage: TaskStatus, attempts: number, maxAttempts: number): TaskStatus {
  if (attempts >= maxAttempts) return "escalated";
  switch (stage) {
    case "test_writing":
      return "test_writing";
    case "implementing":
    case "reviewing":
    case "browser_check":
    case "awaiting_merge":
      return "implementing";
    default:
      return "escalated";
  }
}

export type Decision = "approve" | "request_changes" | "comment";

/**
 * Where a decision sends a task. `null`: not allowed (only escalated tasks take approve or request changes).
 * Approve retries the stage that escalated. Request changes goes to implement when code exists
 *, else back to the stage that escalated, with the comment as feedback.
 */
export function afterDecision(status: TaskStatus, decision: Decision, escalatedFrom: TaskStatus | null): TaskStatus | null {
  if (decision === "comment") return status;
  if (status !== "escalated") return null;
  const retry = escalatedFrom && FACTORY_STAGES.has(escalatedFrom) ? escalatedFrom : "backlog";
  if (decision === "approve") return retry;
  return CODE_STAGES.has(retry) ? "implementing" : retry;
}

export function statusLabel(status: TaskStatus): string {
  return status.replaceAll("_", " ");
}

/* ------------------------------ Pipeline view ------------------------------ */

export type Actor = "agent" | "system";

export interface Stage {
  status: TaskStatus;
  label: string;
  actor: Actor;
  /** What happens while a task is in this stage. */
  doing: string;
}

/** The happy path, in order. `escalated` sits outside it. */
export const PIPELINE: readonly Stage[] = [
  { status: "backlog", label: "Backlog", actor: "system", doing: "Waiting for a worktree" },
  { status: "scoping", label: "Scope", actor: "agent", doing: "Scoping agent writes the solution doc and testable acceptance criteria" },
  { status: "design", label: "Design", actor: "agent", doing: "Design agent writes the task list and the browser plan" },
  { status: "test_writing", label: "Tests", actor: "agent", doing: "Test writer adds failing tests; the factory checks they fail, then locks them" },
  { status: "implementing", label: "Implement", actor: "agent", doing: "Implementer makes the locked tests pass; the factory runs the gate" },
  { status: "reviewing", label: "Review", actor: "agent", doing: "Read-only reviewer checks correctness, integration risk and simplicity" },
  { status: "browser_check", label: "Browser check", actor: "agent", doing: "Browser agent checks each acceptance criterion in the running app" },
  { status: "pr", label: "Pull request", actor: "system", doing: "Commit, push and open a draft pull request" },
  {
    status: "awaiting_merge",
    label: "Awaiting merge",
    actor: "system",
    doing: "CI runs; the factory fixes failing checks and requested changes, marks the PR ready, and a merge agent merges it",
  },
  { status: "done", label: "Done", actor: "system", doing: "Merged" },
];

export const ESCALATED_STAGE: Stage = {
  status: "escalated",
  label: "Escalated",
  actor: "system",
  doing: "Stopped by retries, budget or risk. Retry the stage or request changes",
};

/** The pipeline as a task sees it: the browser check is left out when the change is known not to be visible. */
export function pipelineFor(opts: { needsBrowser?: boolean; current?: TaskStatus } = {}): Stage[] {
  return PIPELINE.filter((s) => s.status !== "browser_check" || opts.needsBrowser !== false || opts.current === "browser_check");
}

export interface PipelinePosition {
  /** 0-based index in the pipeline, or -1 when escalated. */
  index: number;
  total: number;
  stage: Stage;
  next: Stage | null;
}

export function pipelinePosition(status: TaskStatus, opts: { needsBrowser?: boolean } = {}): PipelinePosition {
  const stages = pipelineFor({ ...opts, current: status });
  const index = stages.findIndex((s) => s.status === status);
  if (index === -1) return { index: -1, total: stages.length, stage: ESCALATED_STAGE, next: null };
  return { index, total: stages.length, stage: stages[index]!, next: stages[index + 1] ?? null };
}
