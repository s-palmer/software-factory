/** Request/response contracts for the factory API. Validated on the server, typed on the client. */
import { z } from "zod";
import { TASK_STATUSES, type TaskStatus } from "./lifecycle";
import { PhaseModels, PhaseSchema, type Phase } from "./models";

export const TaskStatusSchema = z.enum(TASK_STATUSES);

export const CreateTaskInput = z
  .object({
  /** Optional with a ticket: the task is titled with the key until scoping copies the issue's title. */
  title: z.string().trim().max(200).default(""),
  description: z.string().trim().max(5000).default(""),
  /** The issue this task builds, e.g. "#12". One task per ticket. */
  ticketKey: z.string().trim().min(1).max(100).optional(),
  /** Per-phase model overrides for this task; other phases use the factory defaults. */
  phaseModels: PhaseModels.default({}),
  /** Tasks (ids or ticket keys like "#5") that must be done (merged) before this one starts. */
  blockedBy: z.array(z.string().trim().min(1)).default([]),
})
  .refine((t) => t.title.length > 0 || Boolean(t.ticketKey), { message: "Title is required (or give a ticket)", path: ["title"] })
  .transform((t) => ({ ...t, title: t.title || t.ticketKey! }));
export type CreateTaskInput = z.input<typeof CreateTaskInput>;

/** Change a task's per-phase overrides: set some, clear others (they fall back to the factory default). */
export const SetModelsInput = z
  .object({
    phaseModels: PhaseModels.optional(),
    clear: z.array(PhaseSchema).default([]),
  })
  .refine((m) => (m.phaseModels && Object.keys(m.phaseModels).length > 0) || m.clear.length > 0, "Give phase models to set or phases to clear");
export type SetModelsInput = z.input<typeof SetModelsInput>;

/** Change the factory's default model for some phases. */
export const SetDefaultModelsInput = z.object({ phaseModels: PhaseModels }).refine((m) => Object.keys(m.phaseModels).length > 0, "Give at least one phase");
export type SetDefaultModelsInput = z.input<typeof SetDefaultModelsInput>;

/** GET/PUT /api/models: the defaults, and what each phase resolves to. */
export interface DefaultModels {
  phaseModels: Record<Phase, string>;
}

export const FeedbackInput = z
  .object({
    decision: z.enum(["approve", "request_changes", "comment"]),
    comment: z.string().trim().max(5000).default(""),
    artifactId: z.string().nullish(),
  })
  .refine((f) => f.decision === "approve" || f.comment.length > 0, {
    message: "A comment is required unless approving",
    path: ["comment"],
  });
export type FeedbackInput = z.input<typeof FeedbackInput>;

export const ArtifactInput = z.object({
  kind: z.enum(["screenshot", "trace", "diff", "report"]),
  /** Path relative to the artifact root, e.g. "screenshots/TaskBoard--seeded.png". */
  path: z.string().min(1).refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), "must be a relative path inside the artifact root"),
  label: z.string().default(""),
});
export type ArtifactInput = z.input<typeof ArtifactInput>;

export interface TaskSummary {
  id: string;
  title: string;
  ticketKey: string | null;
  status: TaskStatus;
  attempts: number;
  costUsd: number;
  /** Ids of tasks this one waits for. */
  blockedBy: string[];
  /** In a factory stage with every blocker done. */
  ready: boolean;
  screenshotCount: number;
  updatedAt: string;
  /**
   * Seconds the factory has worked on the task: from its creation until its pull request was first ready. For an
   * escalated task, until it escalated; for a task still in progress, until now.
   */
  durationSec: number;
  /** The duration is final (the PR was ready, or the task escalated or is done); false while it still grows. */
  durationFinal: boolean;
}

/** Working state the orchestrator keeps per task. */
export interface TaskContext {
  lockedFiles?: string[];
  noTestsReason?: string;
  feedback?: string[];
  questions?: string[];
  decisions?: Array<{ stage: string; question: string; answer: string }>;
  deciderUsed?: string[];
  needsBrowser?: boolean;
  browserPath?: string;
  browserPlan?: Array<{ criterion: string; path: string; steps: string }>;
  untested?: Array<{ criterion: string; reason: string }>;
  followUps?: string[];
  risk?: { level: "low" | "high"; reasons: string[] };
  codeExists?: boolean;
  prTitle?: string;
  prBody?: string;
  prOpenedAt?: string;
  /** When the factory last pushed; reviews before this are already handled. */
  lastPushAt?: string;
  /** When the factory marked the PR ready for review (CI green). */
  readyAt?: string;
  /** A merge agent asked the factory to move the change onto the latest base (`factory sync`). */
  syncRequested?: boolean;
  /** The next push replaces the remote branch (--force-with-lease), after a move onto the base. */
  forcePush?: boolean;
  escalation?: string;
  escalatedFrom?: TaskStatus;
  envWait?: string;
  /** UI units checked on the harness page in the browser check. */
  verified?: { units: string[]; passed: number; total: number };
  /** The GitHub issue, read by the factory when the task starts. Trackers behind MCP are read by the agents. */
  ticket?: { title: string; body: string; url: string; comments: string[] };
}

export interface Task extends TaskSummary {
  description: string;
  phaseModels: Partial<Record<Phase, string>>;
  branch: string | null;
  worktree: string | null;
  prNumber: number | null;
  /** The pull request's web address, when the server knows the repository's GitHub address. */
  prUrl?: string | null;
  context: TaskContext;
  createdAt: string;
}

export type AgentRunStatus = "running" | "passed" | "failed" | "error";

/** A PM run: an idea (intake issue or draft spec) becoming a spec, issues and tasks. */
export const StartPlanInput = z.object({
  source: z.string().trim().regex(/^(#\d+|specs\/[\w./-]+\.md)$/, 'Source must be an issue like "#12" or a spec path like "specs/x.md"'),
});

export interface Plan {
  id: string;
  source: string;
  status: "running" | "filed" | "dry_run" | "escalated" | "failed";
  specPath: string | null;
  attempts: number;
  output: unknown;
  checks: { ok: boolean; failures: string[] } | null;
  filing: { parent: number | null; tickets: Record<string, number>; created: string[]; updated: string[]; removed: string[] } | null;
  prNumber: number | null;
  /** Factory task id per ticket key. */
  tasks: Record<string, string>;
  error: string | null;
  by: string;
  createdAt: string;
  updatedAt: string;
}

/** One agent run or factory check (gate, red check, publish, merge) for a task. */
export interface AgentRun {
  id: string;
  taskId: string;
  stage: TaskStatus;
  /** agent, decider, retro, question, gate, red-check, worktree, publish, merge */
  kind: string;
  status: AgentRunStatus;
  model: string | null;
  costUsd: number;
  turns: number;
  summary: string | null;
  output: unknown;
  logPath: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface Artifact {
  id: string;
  taskId: string;
  kind: ArtifactInput["kind"];
  path: string;
  /** URL the dashboard can load it from. */
  url: string;
  label: string;
  createdAt: string;
}

export interface Feedback {
  id: string;
  taskId: string;
  decision: z.infer<typeof FeedbackInput>["decision"];
  comment: string;
  artifactId: string | null;
  createdAt: string;
}

export interface TaskEvent {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  ts: string;
}

export interface TaskDetail {
  task: Task;
  agentRuns: AgentRun[];
  artifacts: Artifact[];
  feedback: Feedback[];
  events: TaskEvent[];
}

/**
 * A lesson the retro proposed after a task ended. "factory": a rule for how the stages work, applied to the
 * learnings file every later run reads. "codebase": a rule for the repository's own instructions (`target`, such as
 * CLAUDE.md), applied as a new factory task, so it reaches the repository through a pull request.
 */
export interface Learning {
  id: string;
  sourceTaskId: string;
  source: string;
  kind: LearningKind;
  summary: string;
  /** For a codebase learning, the file it belongs in. */
  target: string | null;
  /** What happened in the task that shows the lesson. */
  evidence: string[];
  status: LearningStatus;
  /** "learnings file" or "task:<id>", once applied. */
  appliedTo: string | null;
  appliedAt: string | null;
  createdAt: string;
}

export const LEARNING_KINDS = ["factory", "codebase"] as const;
export type LearningKind = (typeof LEARNING_KINDS)[number];
export type LearningStatus = "open" | "approved" | "rejected";

/** A person's edit or decision on a proposed learning. */
export const UpdateLearningInput = z
  .object({
    summary: z.string().trim().min(1).max(1000).optional(),
    kind: z.enum(LEARNING_KINDS).optional(),
    target: z.string().trim().min(1).max(200).nullable().optional(),
    status: z.enum(["open", "approved", "rejected"]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to change" });
export type UpdateLearningInput = z.infer<typeof UpdateLearningInput>;

/* ---------------------------- Browser test runs ---------------------------- */

export type RunStatus = "running" | "passed" | "failed" | "error";

export const StartRunInput = z.object({
  /** When set, the run's screenshots are attached to this task. */
  taskId: z.string().nullish(),
});
export type StartRunInput = z.input<typeof StartRunInput>;

export interface RunSummary {
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  durationMs: number;
}

export interface TestRun {
  id: string;
  taskId: string | null;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  summary: RunSummary | null;
  /** Playwright HTML report (includes the trace viewer), once the run has finished. */
  reportUrl: string | null;
}

export type AttachmentKind = "screenshot" | "video" | "trace" | "other";

export interface TestAttachment {
  name: string;
  kind: AttachmentKind;
  /** Path relative to the artifact root. */
  path: string;
  url: string;
}

export interface TestResult {
  title: string;
  file: string;
  status: "passed" | "failed" | "flaky" | "skipped";
  durationMs: number;
  error: string | null;
  attachments: TestAttachment[];
}

export interface RunDetail {
  run: TestRun;
  results: TestResult[];
  /** Tail of the runner's combined stdout/stderr. */
  log: string;
}

/** Where tickets live, as the dashboard needs it (`GET /api/tracker`). No server details. */
export type TrackerInfo = { type: "github" } | { type: "mcp"; label: string; keyPattern: string | null };

/** The local environment the browser check uses, and who holds it (`GET /api/env`). */
export interface EnvStatus {
  /** A start command is set in the config. */
  configured: boolean;
  command: string | null;
  url: string;
  healthUrls: string[];
  /** Every health URL answers. */
  up: boolean;
  lease: {
    holder: "task" | "person";
    taskId: string | null;
    ticketKey: string | null;
    title: string | null;
    status: string | null;
    pid: number | null;
    /** The process the factory started is still alive. */
    running: boolean;
    acquiredAt: string;
    logPath: string | null;
  } | null;
  /** The app answers but the factory did not start it. Browser checks wait until it stops. */
  external: boolean;
  /** Who listens on the health URLs' ports, when `external`. */
  portHolders: Array<{ port: number; pid: number; command: string }>;
  /** Tasks waiting for the environment, with why. */
  waiting: Array<{ taskId: string; ticketKey: string | null; title: string; reason: string }>;
  /** The end of the holder's log. */
  log: string;
}

