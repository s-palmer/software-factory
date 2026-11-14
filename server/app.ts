/** HTTP API for the dashboard (and, later, the orchestrator). Pure: no filesystem or ports, so it's testable in-process. */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { ArtifactInput, CreateTaskInput, UpdateLearningInput, FeedbackInput, SetDefaultModelsInput, SetModelsInput, StartPlanInput, StartRunInput, type RunDetail } from "../shared/api";
import { ACTOR_HEADER, ActorSchema, isAgent, type Actor } from "../shared/actor";
import type { RiskPolicy } from "../shared/risk";
import { afterDecision, statusLabel } from "../shared/lifecycle";
import { DuplicateTicketError, UnknownBlockerError, type FactoryDb } from "./db";
import type { Orchestrator } from "./orchestrator";
import type { Planner } from "./planning/pm";
import { RunBusyError, type TestRunner } from "./runner";

/** `orchestrator` is optional: without it the API still serves tasks, and the loop routes answer 503. */
import { normalizeTicketKey, type TrackerConfig } from "../shared/config";
import type { LocalEnv } from "./environment";
import { applyLearnings } from "./learnings";
import { docPaths } from "./phases";

export function createApp(
  db: FactoryDb,
  opts: {
    runner?: TestRunner;
    policy?: RiskPolicy;
    orchestrator?: Orchestrator;
    planner?: Planner;
    tracker?: TrackerConfig;
    env?: LocalEnv;
    artifactRoot?: string;
    learningsFile?: string;
    /** The repository's GitHub address, so a task links to its pull request. */
    repoWebUrl?: string | null;
  } = {},
) {
  const { runner, policy, orchestrator, planner, env, artifactRoot, learningsFile, repoWebUrl } = opts;
  const tracker = opts.tracker ?? { type: "github" as const };
  const app = new Hono<{ Variables: { actor: Actor } }>();

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "Internal error" }, 500);
  });

  /** Every request names its actor (default "human"); events record it, and some actions are refused to agents. */
  app.use("/api/*", async (c, next) => {
    const parsed = ActorSchema.safeParse(c.req.header(ACTOR_HEADER) ?? "human");
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid actor" }, 400);
    c.set("actor", parsed.data);
    await next();
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/tasks", async (c) => c.json(await db.listTasks()));

  app.post("/api/tasks", async (c) => {
    const parsed = CreateTaskInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
    const input = parsed.data;
    if (input.ticketKey) {
      const key = normalizeTicketKey(tracker, input.ticketKey);
      if (!key.ok) return c.json({ error: key.error }, 400);
      if (input.title === input.ticketKey) input.title = key.key;
      input.ticketKey = key.key;
    }
    try {
      const created = await db.createTask(input, "backlog", c.get("actor"));
      if (input.gates) await db.updateTask(created.id, { context: { gates: input.gates } });
      return c.json(input.gates ? await db.getTask(created.id) : created, 201);
    } catch (err) {
      if (err instanceof DuplicateTicketError) return c.json({ error: err.message, taskId: err.taskId }, 409);
      if (err instanceof UnknownBlockerError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  app.get("/api/tasks/:id", async (c) => {
    const detail = await db.getTaskDetail(c.req.param("id"));
    if (!detail) return c.json({ error: "Task not found" }, 404);
    const prUrl = repoWebUrl && detail.task.prNumber !== null ? `${repoWebUrl}/pull/${detail.task.prNumber}` : null;
    return c.json({ ...detail, task: { ...detail.task, prUrl } });
  });

  /** The factory's default model for each phase (shared/models.ts). */
  app.get("/api/models", async (c) => c.json({ phaseModels: await db.getDefaultModels() }));

  app.put("/api/models", async (c) => {
    const parsed = SetDefaultModelsInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
    return c.json({ phaseModels: await db.setDefaultModels(parsed.data.phaseModels) });
  });

  /** A task's per-phase model overrides. */
  app.put("/api/tasks/:id/models", async (c) => {
    const parsed = SetModelsInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
    const task = await db.setModels(c.req.param("id"), parsed.data, c.get("actor"));
    return task ? c.json(task) : c.json({ error: "Task not found" }, 404);
  });

  /* ---------------------------- Orchestrator loop ---------------------------- */

  app.get("/api/orchestrator", (c) => c.json({ available: Boolean(orchestrator), running: orchestrator?.running ?? false, ...(orchestrator ? { load: orchestrator.load } : {}) }));

  app.put("/api/orchestrator", async (c) => {
    if (!orchestrator) return c.json({ error: "The orchestrator is not configured on this server" }, 503);
    const body = (await c.req.json().catch(() => null)) as { running?: unknown } | null;
    if (typeof body?.running !== "boolean") return c.json({ error: "running must be true or false" }, 400);
    if (body.running) orchestrator.start();
    else orchestrator.stop();
    return c.json({ available: true, running: orchestrator.running });
  });

  /* ---------------------------- Control: halt and notify ---------------------------- */

  app.get("/api/control", async (c) => c.json({ halt: await db.getHalt() }));

  /** `{ halted: true, reason }` stops the loop; only a person may lift it. */
  app.put("/api/control", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { halted?: unknown; reason?: unknown } | null;
    if (typeof body?.halted !== "boolean") return c.json({ error: "halted must be true or false" }, 400);
    const actor = c.get("actor");
    if (body.halted) {
      if (typeof body.reason !== "string" || !body.reason.trim()) return c.json({ error: "A halt needs a reason" }, 400);
      await db.setHalt({ reason: body.reason.trim(), by: actor });
      await db.addNotification(`Factory halted by ${actor}: ${body.reason.trim()}`, null, actor);
    } else {
      if (isAgent(actor)) return c.json({ error: `${actor} may not lift a halt; only a person can` }, 403);
      await db.setHalt(null);
    }
    return c.json({ halt: await db.getHalt() });
  });

  app.get("/api/notifications", async (c) => c.json(await db.listNotifications()));

  /** The event feed (docs/INTERFACE.md): `?since=<event id>&limit=<n>&types=a,b`. Poll with the returned cursor. */
  app.get("/api/events", async (c) => {
    const since = Number(c.req.query("since") ?? 0);
    const limit = Number(c.req.query("limit") ?? 200);
    if (!Number.isInteger(since) || since < 0 || !Number.isInteger(limit) || limit < 1) return c.json({ error: "since and limit must be whole numbers" }, 400);
    const types = c.req.query("types")?.split(",").map((t) => t.trim()).filter(Boolean);
    const events = await db.eventsSince(since, limit, types);
    return c.json({ events, cursor: events.at(-1)?.id ?? since });
  });

  app.post("/api/notifications", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { message?: unknown; taskId?: unknown } | null;
    if (typeof body?.message !== "string" || !body.message.trim()) return c.json({ error: "A notification needs a message" }, 400);
    const taskId = typeof body.taskId === "string" ? body.taskId : null;
    if (taskId && !(await db.getTask(taskId))) return c.json({ error: "Task not found" }, 404);
    await db.addNotification(body.message.trim().slice(0, 2000), taskId, c.get("actor"));
    console.log(`[factory] notification${taskId ? ` (task ${taskId})` : ""}: ${body.message.trim()}`);
    return c.json({ ok: true }, 201);
  });

  /* ---------------------------- Plans (the PM agent) ---------------------------- */

  app.get("/api/plans", async (c) => c.json(await db.listPlans()));

  app.get("/api/plans/:id", async (c) => {
    const plan = await db.getPlan(c.req.param("id"));
    if (!plan) return c.json({ error: "Plan not found" }, 404);
    return c.json({ plan, runs: await db.listAgentRuns(plan.id) });
  });

  /** Start a PM run on an intake issue or a draft spec. Returns at once; the plan runs in the background. */
  app.post("/api/plans", async (c) => {
    if (tracker.type !== "github") return c.json({ error: `The PM run files GitHub issues, so it is off when tickets live in ${tracker.label}` }, 409);
    if (!planner) return c.json({ error: "The planner is not configured on this server" }, 503);
    const parsed = StartPlanInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
    const id = await planner.start(parsed.data.source, c.get("actor"));
    return c.json({ id, status: "running" }, 202);
  });

  app.get("/api/tracker", (c) =>
    c.json(tracker.type === "github" ? { type: "github" } : { type: "mcp", label: tracker.label, keyPattern: tracker.keyPattern ?? null }),
  );

  /** The solution doc and the task list the agents wrote, for a person to read, above all at a gate. */
  app.get("/api/tasks/:id/docs", async (c) => {
    const task = await db.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "Task not found" }, 404);
    const paths = docPaths(task);
    const read = (path: string) => {
      const file = task.worktree ? join(task.worktree, path) : null;
      return file && existsSync(file) ? readFileSync(file, "utf8") : null;
    };
    return c.json({ solution: { path: paths.solution, text: read(paths.solution) }, tasks: { path: paths.tasks, text: read(paths.tasks) } });
  });

  /** The local environment for the browser check: who holds it, and a person's start and stop. */
  app.get("/api/env", async (c) => (env ? c.json(await env.status()) : c.json({ error: "The orchestrator is not configured on this server" }, 503)));

  app.post("/api/env/:action{start|stop}", async (c) => {
    if (!env) return c.json({ error: "The orchestrator is not configured on this server" }, 503);
    const actor = c.get("actor");
    if (isAgent(actor)) return c.json({ error: `${actor} may not start or stop the local environment; only a person can` }, 403);
    const result = c.req.param("action") === "start" ? await env.start() : await env.stop();
    return c.json(result, result.ok ? 200 : 409);
  });

  /** A merge agent asks the factory to move a PR's change onto the latest base and resolve conflicts. */
  app.post("/api/tasks/:id/sync", async (c) => {
    const task = await db.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "Task not found" }, 404);
    if (task.status !== "awaiting_merge") return c.json({ error: `Only a task awaiting merge can be synced; this one is ${task.status}` }, 409);
    await db.updateTask(task.id, { context: { syncRequested: true } });
    await db.recordEvent(task.id, "sync_requested", { by: c.get("actor") });
    return c.json({ ok: true }, 202);
  });

  /** Run one step of this task now, beside the loop. Returns at once; the step runs in the background. */
  app.post("/api/tasks/:id/step", async (c) => {
    if (!orchestrator) return c.json({ error: "The orchestrator is not configured on this server" }, 503);
    const task = await db.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "Task not found" }, 404);
    void orchestrator.step(task.id);
    return c.json({ ok: true, status: task.status }, 202);
  });

  /** What always needs a human, so the dashboard can explain the autonomy modes. */
  app.get("/api/policy", (c) => (policy ? c.json(policy) : c.json({ error: "No policy loaded" }, 404)));

  /** Agents (via the orchestrator) register screenshots, traces and reports here. */
  app.post("/api/tasks/:id/artifacts", async (c) => {
    const task = await db.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "Task not found" }, 404);
    const parsed = ArtifactInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
    return c.json(await db.addArtifact(task.id, parsed.data), 201);
  });

  /** A person removes a screenshot or other artifact: its record and, when it is under the artifact root, its file. */
  app.delete("/api/artifacts/:id", async (c) => {
    const artifact = await db.deleteArtifact(c.req.param("id"), c.get("actor"));
    if (!artifact) return c.json({ error: "Artifact not found" }, 404);
    if (artifactRoot) {
      const file = resolve(artifactRoot, artifact.path);
      if (file.startsWith(`${resolve(artifactRoot)}/`)) rmSync(file, { force: true });
    }
    return c.json(artifact);
  });

  app.post("/api/tasks/:id/feedback", async (c) => {
    const task = await db.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "Task not found" }, 404);
    const parsed = FeedbackInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);

    const { decision, comment } = parsed.data;
    const artifactId = parsed.data.artifactId ?? null;
    if (artifactId && !(await db.artifactBelongsTo(artifactId, task.id))) {
      return c.json({ error: "Screenshot does not belong to this task" }, 400);
    }
    // Limits on agents: one retry per escalation reason, two change requests per task. A gate is a person's decision.
    const actor = c.get("actor");
    if (isAgent(actor) && task.status === "awaiting_approval" && decision !== "comment") {
      return c.json({ error: `${actor} may not decide at a gate; the task waits for a person's approval` }, 403);
    }
    if (isAgent(actor) && decision === "approve" && (await db.countDecisions(task.id, actor, "approve", task.context.escalation ?? "")) >= 1) {
      return c.json({ error: `${actor} already retried this escalation once; a person must decide now` }, 403);
    }
    if (isAgent(actor) && decision === "request_changes" && (await db.countDecisions(task.id, actor, "request_changes")) >= 2) {
      return c.json({ error: `${actor} already requested changes twice on this task; a person must decide now` }, 403);
    }
    const from = task.status === "awaiting_approval" ? (task.context.gateStage ?? null) : (task.context.escalatedFrom ?? null);
    const next = afterDecision(task.status, decision, from);
    if (!next) {
      return c.json({ error: `Can't ${decision.replace("_", " ")} a task that is ${statusLabel(task.status)}; only escalated tasks and tasks waiting for approval take decisions` }, 409);
    }
    const feedback = await db.recordFeedback(task, { decision, comment, artifactId }, next, c.get("actor"));
    return c.json({ feedback, task: await db.getTask(task.id) }, 201);
  });

  /* ---------------------------- Browser test runs ---------------------------- */

  app.get("/api/agent-runs", async (c) => c.json(await db.listAgentRuns()));

  app.get("/api/agent-runs/:id", async (c) => {
    const run = await db.getAgentRun(c.req.param("id"));
    return run ? c.json(run) : c.json({ error: "Run not found" }, 404);
  });

  app.get("/api/runs", async (c) => c.json(await db.listRuns()));

  app.post("/api/runs", async (c) => {
    if (!runner) return c.json({ error: "Test runs are not enabled on this server" }, 503);
    const parsed = StartRunInput.safeParse((await c.req.json().catch(() => ({}))) ?? {});
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
    const taskId = parsed.data.taskId ?? null;
    if (taskId && !(await db.getTask(taskId))) return c.json({ error: "Task not found" }, 404);
    try {
      const { run } = await runner.start(taskId);
      return c.json(run, 202);
    } catch (err) {
      if (err instanceof RunBusyError) return c.json({ error: err.message, runningId: err.runningId }, 409);
      throw err;
    }
  });

  app.get("/api/runs/:id", async (c) => {
    const id = c.req.param("id");
    const run = await db.getRun(id);
    if (!run) return c.json({ error: "Run not found" }, 404);
    const detail: RunDetail = { run, results: await db.getRunResults(id), log: runner?.readLog(id) ?? "" };
    return c.json(detail);
  });

  app.get("/api/learnings", async (c) => c.json(await db.listLearnings()));

  /** A person edits a proposed learning, or approves or rejects it. Agents may not decide what every run reads. */
  app.patch("/api/learnings/:id", async (c) => {
    const actor = c.get("actor");
    if (isAgent(actor)) return c.json({ error: `${actor} may not change learnings; only a person can` }, 403);
    const parsed = UpdateLearningInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
    try {
      const learning = await db.updateLearning(c.req.param("id"), parsed.data, actor);
      return learning ? c.json(learning) : c.json({ error: "Learning not found" }, 404);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 409);
    }
  });

  /** Applies every approved learning: factory ones to the learnings file, codebase ones as new tasks. */
  app.post("/api/learnings/apply", async (c) => {
    const actor = c.get("actor");
    if (isAgent(actor)) return c.json({ error: `${actor} may not apply learnings; only a person can` }, 403);
    if (!learningsFile) return c.json({ error: "No learnings file is configured on this server" }, 503);
    return c.json(await applyLearnings(db, learningsFile, actor));
  });

  return app;
}
