/**
 * DuckDB storage. This process is the only writer (DuckDB allows one read-write process per file);
 * agents never touch the database. Migrations run in place on open.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import type {
  AgentRun,
  AgentRunStatus,
  Plan,
  Artifact,
  ArtifactInput,
  Feedback,
  Learning,
  LearningKind,
  UpdateLearningInput,
  RunStatus,
  RunSummary,
  Task,
  TaskContext,
  TaskDetail,
  TaskEvent,
  TaskSummary,
  TestResult,
  TestRun,
} from "../shared/api";
import type { Decision, TaskStatus } from "../shared/lifecycle";
import { DEFAULT_PHASE_MODELS, PhaseModels, type Phase } from "../shared/models";
import { artifactUrl } from "./report";

export class UnknownBlockerError extends Error {}

export class DuplicateTicketError extends Error {
  constructor(
    readonly ticketKey: string,
    readonly taskId: string,
  ) {
    super(`Ticket ${ticketKey} already has task ${taskId}`);
  }
}

export type Lease = { taskId: string | null; pid: number | null; logPath: string | null; acquiredAt: string };

/**
 * How long the factory worked on a task, in one clock (the database's): from creation to the first time its PR was
 * ready; for an escalated or finished task without one, to its last update; otherwise to now.
 */
const DURATION_COLUMNS = `
  epoch(coalesce(
    (SELECT min(e.ts) FROM events e WHERE e.task_id = t.id AND e.type = 'pr_ready'),
    CASE WHEN t.status IN ('escalated', 'done') THEN t.updated_at END,
    now()::TIMESTAMP
  ) - t.created_at) AS duration_sec,
  ((SELECT count(*) FROM events e WHERE e.task_id = t.id AND e.type = 'pr_ready') > 0 OR t.status IN ('escalated', 'done')) AS duration_final`;

const SCHEMA = `
CREATE SEQUENCE IF NOT EXISTS event_seq;
CREATE TABLE IF NOT EXISTS tasks (
  id VARCHAR PRIMARY KEY,
  title VARCHAR NOT NULL,
  description VARCHAR NOT NULL DEFAULT '',
  status VARCHAR NOT NULL,
  acceptance_criteria JSON,
  file_plan JSON,
  locked_files JSON,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS autonomy VARCHAR DEFAULT 'supervised';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ticket_key VARCHAR;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS model_level VARCHAR DEFAULT 'deep';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS phase_models JSON DEFAULT '{}';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS branch VARCHAR;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS worktree VARCHAR;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pr_number INTEGER;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS attempts INTEGER DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS cost_usd DOUBLE DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS context JSON DEFAULT '{}';
-- Stages from older databases, which had human gates, map onto the autonomous lifecycle.
UPDATE tasks SET status = CASE status
  WHEN 'awaiting_scope_approval' THEN 'scoping'
  WHEN 'browser_verifying' THEN 'browser_check'
  WHEN 'awaiting_merge_approval' THEN 'pr'
  WHEN 'merge_queue' THEN 'awaiting_merge'
  WHEN 'merging' THEN 'awaiting_merge'
  WHEN 'retro' THEN 'done'
  ELSE status END
WHERE status IN ('awaiting_scope_approval', 'browser_verifying', 'awaiting_merge_approval', 'merge_queue', 'retro', 'merging');
CREATE TABLE IF NOT EXISTS agent_runs (
  id VARCHAR PRIMARY KEY,
  task_id VARCHAR NOT NULL,
  stage VARCHAR NOT NULL,
  kind VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  model VARCHAR,
  session_id VARCHAR,
  cost_usd DOUBLE NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  log_path VARCHAR,
  output JSON,
  summary VARCHAR,
  started_at TIMESTAMP NOT NULL DEFAULT now(),
  ended_at TIMESTAMP
);
CREATE TABLE IF NOT EXISTS task_deps (
  task_id VARCHAR NOT NULL,
  blocked_by VARCHAR NOT NULL,
  until VARCHAR NOT NULL DEFAULT 'merged',
  PRIMARY KEY (task_id, blocked_by)
);
CREATE TABLE IF NOT EXISTS plans (
  id VARCHAR PRIMARY KEY,
  source VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  spec_path VARCHAR,
  attempts INTEGER NOT NULL DEFAULT 0,
  output JSON,
  checks JSON,
  filing JSON,
  pr_number INTEGER,
  tasks JSON,
  error VARCHAR,
  created_by VARCHAR NOT NULL DEFAULT 'human',
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS settings (
  key VARCHAR PRIMARY KEY,
  value JSON NOT NULL
);
CREATE TABLE IF NOT EXISTS leases (
  resource VARCHAR PRIMARY KEY,
  task_id VARCHAR,
  pid INTEGER,
  acquired_at TIMESTAMP NOT NULL DEFAULT now()
);
ALTER TABLE leases ADD COLUMN IF NOT EXISTS log_path VARCHAR;
CREATE TABLE IF NOT EXISTS events (
  id BIGINT PRIMARY KEY DEFAULT nextval('event_seq'),
  task_id VARCHAR,
  ts TIMESTAMP NOT NULL DEFAULT now(),
  type VARCHAR NOT NULL,
  payload JSON
);
CREATE TABLE IF NOT EXISTS artifacts (
  id VARCHAR PRIMARY KEY,
  task_id VARCHAR NOT NULL,
  attempt_id VARCHAR,
  kind VARCHAR NOT NULL,
  path VARCHAR NOT NULL,
  label VARCHAR NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS feedback (
  id VARCHAR PRIMARY KEY,
  task_id VARCHAR NOT NULL,
  decision VARCHAR NOT NULL,
  comment VARCHAR NOT NULL DEFAULT '',
  artifact_id VARCHAR,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS test_runs (
  id VARCHAR PRIMARY KEY,
  task_id VARCHAR,
  status VARCHAR NOT NULL,
  started_at TIMESTAMP NOT NULL DEFAULT now(),
  ended_at TIMESTAMP,
  exit_code INTEGER,
  summary JSON,
  results JSON,
  report_path VARCHAR
);
CREATE TABLE IF NOT EXISTS learnings (
  id VARCHAR PRIMARY KEY,
  source_task_id VARCHAR,
  source VARCHAR NOT NULL,
  category VARCHAR,
  summary VARCHAR NOT NULL,
  evidence JSON,
  status VARCHAR NOT NULL DEFAULT 'open',
  promoted_to VARCHAR,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
ALTER TABLE learnings ADD COLUMN IF NOT EXISTS target VARCHAR;
ALTER TABLE learnings ADD COLUMN IF NOT EXISTS applied_at TIMESTAMP;
`;

type Row = Record<string, unknown>;
type Param = string | number | boolean | null;

export class FactoryDb {
  /**
   * All requests share one connection, so statements from concurrent requests would otherwise
   * interleave with each other's transactions. Every statement waits its turn; a transaction holds
   * the turn until it commits, and statements inside it (tracked via AsyncLocalStorage) run straight through.
   */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly inTx = new AsyncLocalStorage<true>();

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inTx.getStore()) return fn();
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly conn: DuckDBConnection,
  ) {}

  /** `path` is a DuckDB file, or ":memory:" for tests. */
  static async open(path: string): Promise<FactoryDb> {
    const instance = await DuckDBInstance.create(path);
    const conn = await instance.connect();
    await conn.run(SCHEMA);
    return new FactoryDb(instance, conn);
  }

  close(): void {
    this.conn.closeSync();
    this.instance.closeSync();
  }

  private all(sql: string, params: Param[] = []): Promise<Row[]> {
    return this.exclusive(async () => (await this.conn.runAndReadAll(sql, params)).getRowObjectsJson() as Row[]);
  }

  private exec(sql: string, params: Param[] = []): Promise<void> {
    return this.exclusive(async () => void (await this.conn.run(sql, params)));
  }

  /** Run `fn` in a transaction (holding the connection exclusively); roll back if it throws. */
  private tx<T>(fn: () => Promise<T>): Promise<T> {
    return this.exclusive(() =>
      this.inTx.run(true, async () => {
        await this.conn.run("BEGIN TRANSACTION");
        try {
          const out = await fn();
          await this.conn.run("COMMIT");
          return out;
        } catch (err) {
          await this.conn.run("ROLLBACK");
          throw err;
        }
      }),
    );
  }

  private async event(taskId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    await this.exec("INSERT INTO events (task_id, type, payload) VALUES ($1, $2, $3)", [taskId, type, JSON.stringify(payload)]);
  }

  async createTask(
    input: { title: string; description: string; ticketKey?: string; phaseModels?: PhaseModels; blockedBy?: string[] },
    status: TaskStatus = "backlog",
    by = "human",
  ): Promise<Task> {
    const id = crypto.randomUUID();
    const ticketKey = input.ticketKey ?? null;
    await this.tx(async () => {
      if (ticketKey) {
        // One task per ticket: a second one would reuse the worktree and the branch.
        const [existing] = await this.all("SELECT id FROM tasks WHERE ticket_key = $1", [ticketKey]);
        if (existing) throw new DuplicateTicketError(ticketKey, String(existing.id));
      }
      await this.exec("INSERT INTO tasks (id, title, description, status, ticket_key, phase_models) VALUES ($1, $2, $3, $4, $5, $6)", [
        id, input.title, input.description, status, ticketKey, JSON.stringify(input.phaseModels ?? {}),
      ]);
      // Blockers go in with the task, so the loop can never start it before they are stored.
      const blockers: string[] = [];
      for (const ref of input.blockedBy ?? []) {
        const [row] = await this.all("SELECT id FROM tasks WHERE id = $1 OR ticket_key = $1", [ref]);
        if (!row) throw new UnknownBlockerError(`Unknown blocker ${ref}`);
        if (!blockers.includes(String(row.id))) blockers.push(String(row.id));
      }
      for (const blocker of blockers) await this.exec("INSERT INTO task_deps (task_id, blocked_by) VALUES ($1, $2)", [id, blocker]);
      await this.event(id, "task_created", { title: input.title, status, ticketKey, phaseModels: input.phaseModels ?? {}, blockedBy: blockers, by });
    });
    const task = await this.getTask(id);
    if (!task) throw new Error(`task ${id} vanished after insert`);
    return task;
  }

  async listTasks(): Promise<TaskSummary[]> {
    const rows = await this.all(`
      SELECT t.id, t.title, t.ticket_key, t.status, t.attempts, ${DEPS_COLUMNS}, t.cost_usd, strftime(t.updated_at, '%Y-%m-%dT%H:%M:%S') AS updated_at,
             (SELECT count(*) FROM artifacts a WHERE a.task_id = t.id AND a.kind = 'screenshot')::INTEGER AS screenshot_count,
             ${DURATION_COLUMNS}
      FROM tasks t ORDER BY t.updated_at DESC, t.created_at DESC, t.id`);
    return rows.map(toSummary);
  }

  async getTask(id: string): Promise<Task | null> {
    const [row] = await this.all(
      `SELECT t.* REPLACE (strftime(t.created_at, '%Y-%m-%dT%H:%M:%S') AS created_at, strftime(t.updated_at, '%Y-%m-%dT%H:%M:%S') AS updated_at), ${DEPS_COLUMNS},
              (SELECT count(*) FROM artifacts a WHERE a.task_id = t.id AND a.kind = 'screenshot')::INTEGER AS screenshot_count,
              ${DURATION_COLUMNS}
       FROM tasks t WHERE t.id = $1`,
      [id],
    );
    return row ? toTask(row) : null;
  }

  async getTaskDetail(id: string): Promise<TaskDetail | null> {
    const task = await this.getTask(id);
    if (!task) return null;
    const [agentRuns, artifacts, feedback, events] = await Promise.all([
      this.listAgentRuns(id),
      this.all("SELECT * REPLACE (strftime(created_at, '%Y-%m-%dT%H:%M:%S') AS created_at) FROM artifacts WHERE task_id = $1 ORDER BY created_at, label", [id]),
      this.all("SELECT * REPLACE (strftime(created_at, '%Y-%m-%dT%H:%M:%S') AS created_at) FROM feedback WHERE task_id = $1 ORDER BY created_at", [id]),
      this.all("SELECT id::INTEGER AS id, type, payload, strftime(ts, '%Y-%m-%dT%H:%M:%S') AS ts FROM events WHERE task_id = $1 ORDER BY id", [id]),
    ]);
    return {
      task,
      agentRuns,
      artifacts: artifacts.map(toArtifact),
      feedback: feedback.map(toFeedback),
      events: events.map((e): TaskEvent => ({ id: Number(e.id), type: String(e.type), payload: parseJson(e.payload), ts: String(e.ts) })),
    };
  }

  async addArtifact(taskId: string, input: Required<ArtifactInput>): Promise<Artifact> {
    const id = crypto.randomUUID();
    await this.tx(async () => {
      await this.exec("INSERT INTO artifacts (id, task_id, kind, path, label) VALUES ($1, $2, $3, $4, $5)", [id, taskId, input.kind, input.path, input.label]);
      await this.exec("UPDATE tasks SET updated_at = now() WHERE id = $1", [taskId]);
      await this.event(taskId, "artifact_added", { artifactId: id, kind: input.kind, path: input.path });
    });
    const [row] = await this.all("SELECT * REPLACE (strftime(created_at, '%Y-%m-%dT%H:%M:%S') AS created_at) FROM artifacts WHERE id = $1", [id]);
    return toArtifact(row!);
  }

  /** Removes an artifact's record and returns it, so the caller can delete its file. Null when there is none. */
  async deleteArtifact(id: string, by = "human"): Promise<Artifact | null> {
    const [row] = await this.all("SELECT * REPLACE (strftime(created_at, '%Y-%m-%dT%H:%M:%S') AS created_at) FROM artifacts WHERE id = $1", [id]);
    if (!row) return null;
    const artifact = toArtifact(row);
    await this.tx(async () => {
      await this.exec("DELETE FROM artifacts WHERE id = $1", [id]);
      await this.event(artifact.taskId, "artifact_removed", { artifactId: id, path: artifact.path, label: artifact.label, by });
    });
    return artifact;
  }

  /** Change a task's per-phase model overrides: `phaseModels` set, `clear` falls back to the factory default. */
  async setModels(taskId: string, change: { phaseModels?: PhaseModels; clear?: Phase[] }, by = "human"): Promise<Task | null> {
    const task = await this.getTask(taskId);
    if (!task) return null;
    const phaseModels: PhaseModels = { ...task.phaseModels, ...change.phaseModels };
    for (const phase of change.clear ?? []) delete phaseModels[phase];
    await this.tx(async () => {
      await this.exec("UPDATE tasks SET phase_models = $1, updated_at = now() WHERE id = $2", [JSON.stringify(phaseModels), taskId]);
      await this.event(taskId, "models_changed", { from: task.phaseModels, to: phaseModels, by });
    });
    return this.getTask(taskId);
  }

  /** The kill switch: set by a person or an agent, lifted only by a person (the API enforces who). */
  async getHalt(): Promise<{ reason: string; by: string; at: string } | null> {
    const [row] = await this.all("SELECT value FROM settings WHERE key = 'halt'");
    const value = parseJson(row?.value);
    return typeof value.reason === "string" ? (value as { reason: string; by: string; at: string }) : null;
  }

  async setHalt(halt: { reason: string; by: string } | null): Promise<void> {
    if (!halt) return void (await this.exec("DELETE FROM settings WHERE key = 'halt'"));
    const value = JSON.stringify({ ...halt, at: new Date().toISOString().slice(0, 19) });
    await this.exec("INSERT INTO settings (key, value) VALUES ('halt', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [value]);
  }

  /**
   * The event feed for external agents: every event after `since` (an event id), oldest first, with the task's
   * ticket and current status. The last id is the cursor for the next call.
   */
  async eventsSince(since: number, limit = 200, types?: string[]): Promise<Array<{ id: number; taskId: string | null; ticketKey: string | null; status: string | null; type: string; payload: Record<string, unknown>; ts: string }>> {
    const filter = types?.length ? `AND e.type IN (${types.map((_, i) => `$${i + 2}`).join(", ")})` : "";
    const rows = await this.all(
      `SELECT e.id::INTEGER AS id, e.task_id, t.ticket_key, t.status, e.type, e.payload, strftime(e.ts, '%Y-%m-%dT%H:%M:%S') AS ts
       FROM events e LEFT JOIN tasks t ON t.id = e.task_id WHERE e.id > $1 ${filter} ORDER BY e.id LIMIT ${Math.min(1000, Math.max(1, Math.floor(limit)))}`,
      [since, ...(types ?? [])],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      taskId: r.task_id == null ? null : String(r.task_id),
      ticketKey: r.ticket_key == null ? null : String(r.ticket_key),
      status: r.status == null ? null : String(r.status),
      type: String(r.type),
      payload: parseJson(r.payload),
      ts: String(r.ts),
    }));
  }

  /** A message for a person. Stored as an event; `taskId` null for the factory. */
  async addNotification(message: string, taskId: string | null, by: string): Promise<void> {
    await this.exec("INSERT INTO events (task_id, type, payload) VALUES ($1, 'notification', $2)", [taskId, JSON.stringify({ message, by })]);
  }

  async listNotifications(limit = 50): Promise<Array<{ id: number; taskId: string | null; message: string; by: string; ts: string }>> {
    const rows = await this.all(
      `SELECT id::INTEGER AS id, task_id, payload, strftime(ts, '%Y-%m-%dT%H:%M:%S') AS ts FROM events WHERE type = 'notification' ORDER BY id DESC LIMIT ${Math.max(1, Math.floor(limit))}`,
    );
    return rows.map((r) => {
      const p = parseJson(r.payload);
      return { id: Number(r.id), taskId: r.task_id == null ? null : String(r.task_id), message: String(p.message ?? ""), by: String(p.by ?? ""), ts: String(r.ts) };
    });
  }

  /** How often an actor already took a decision on a task: for the conductor's limits. `escalation`: only for this reason. */
  async countDecisions(taskId: string, by: string, decision: Decision, escalation?: string): Promise<number> {
    const rows = await this.all("SELECT payload FROM events WHERE task_id = $1 AND type = 'human_feedback'", [taskId]);
    return rows.map((r) => parseJson(r.payload)).filter((p) => p.by === by && p.decision === decision && (escalation === undefined || p.escalation === escalation)).length;
  }

  /** The factory's default model per phase (saved; the shipped defaults fill any phase not saved). */
  async getDefaultModels(): Promise<Record<Phase, string>> {
    const [row] = await this.all("SELECT value FROM settings WHERE key = 'phase_models'");
    const saved = PhaseModels.safeParse(parseJson(row?.value));
    return { ...DEFAULT_PHASE_MODELS, ...(saved.success ? saved.data : {}) };
  }

  async setDefaultModels(change: PhaseModels): Promise<Record<Phase, string>> {
    const next = { ...(await this.getDefaultModels()), ...change };
    await this.exec("INSERT INTO settings (key, value) VALUES ('phase_models', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [JSON.stringify(next)]);
    return next;
  }

  /** Ids of tasks in these stages, longest-waiting first (full timestamp precision). */
  async taskQueue(statuses: readonly TaskStatus[]): Promise<string[]> {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map((_, i) => `$${i + 1}`).join(", ");
    // Only ready tasks: every blocker is done (merged). A blocker that escalated keeps its dependents waiting.
    const rows = await this.all(
      `SELECT id FROM tasks t WHERE status IN (${placeholders}) AND NOT EXISTS (
         SELECT 1 FROM task_deps d JOIN tasks b ON b.id = d.blocked_by WHERE d.task_id = t.id AND b.status <> 'done')
       ORDER BY updated_at, created_at, id`,
      [...statuses],
    );
    return rows.map((r) => String(r.id));
  }

  /** Public so the orchestrator can record its own events (decisions, skipped captures). */
  async recordEvent(taskId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    await this.event(taskId, type, payload);
  }

  /**
   * Move a task only if it is still in `from` (compare-and-set), so two writers cannot both move it.
   * Returns false when the stage had already changed.
   */
  async moveTask(taskId: string, from: TaskStatus, to: TaskStatus, by = "factory"): Promise<boolean> {
    if (from === to) return true;
    return this.tx(async () => {
      const moved = await this.all("UPDATE tasks SET status = $1, updated_at = now() WHERE id = $2 AND status = $3 RETURNING id", [to, taskId, from]);
      if (moved.length === 0) return false;
      await this.event(taskId, "status_changed", { from, to, by });
      return true;
    });
  }

  /** Update working fields. `context` merges into the stored context; a key set to undefined is removed. */
  async updateTask(
    taskId: string,
    patch: { title?: string; attempts?: number; branch?: string | null; worktree?: string | null; prNumber?: number | null; context?: Partial<TaskContext> },
  ): Promise<void> {
    await this.tx(async () => {
      const [row] = await this.all("SELECT context FROM tasks WHERE id = $1", [taskId]);
      if (!row) throw new Error(`Task ${taskId} not found`);
      const sets: string[] = ["updated_at = now()"];
      const params: Param[] = [];
      const set = (column: string, value: Param) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };
      if (patch.title !== undefined) set("title", patch.title);
      if (patch.attempts !== undefined) set("attempts", patch.attempts);
      if (patch.branch !== undefined) set("branch", patch.branch);
      if (patch.worktree !== undefined) set("worktree", patch.worktree);
      if (patch.prNumber !== undefined) set("pr_number", patch.prNumber);
      if (patch.context) set("context", JSON.stringify(mergeContext(parseJson(row.context) as TaskContext, patch.context)));
      params.push(taskId);
      await this.exec(`UPDATE tasks SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
    });
  }

  async artifactBelongsTo(artifactId: string, taskId: string): Promise<boolean> {
    return (await this.all("SELECT 1 FROM artifacts WHERE id = $1 AND task_id = $2", [artifactId, taskId])).length > 0;
  }

  /**
   * Record a decision and move the task to `nextStatus`. A move (retry or changes) resets the attempt count
   * and the decider, and request changes adds the comment to the feedback the next phase reads.
   * Comments are not saved as learnings: nearly all of them are task-specific noise.
   */
  async recordFeedback(
    task: Task,
    input: { decision: Decision; comment: string; artifactId: string | null },
    nextStatus: TaskStatus,
    by = "human",
  ): Promise<Feedback> {
    const id = crypto.randomUUID();
    await this.tx(async () => {
      await this.exec("INSERT INTO feedback (id, task_id, decision, comment, artifact_id) VALUES ($1, $2, $3, $4, $5)", [
        id, task.id, input.decision, input.comment, input.artifactId,
      ]);
      await this.event(task.id, "human_feedback", { feedbackId: id, decision: input.decision, artifactId: input.artifactId, escalation: task.context.escalation ?? null, by });
      if (nextStatus !== task.status) {
        const context = mergeContext(task.context, {
          deciderUsed: [],
          escalation: undefined,
          gateStage: undefined,
          ...(input.decision === "request_changes" ? { feedback: [`A person asked for changes: ${input.comment}`] } : {}),
        });
        await this.exec("UPDATE tasks SET status = $1, attempts = 0, context = $2, updated_at = now() WHERE id = $3", [nextStatus, JSON.stringify(context), task.id]);
        await this.event(task.id, "status_changed", { from: task.status, to: nextStatus, by });
      } else {
        await this.exec("UPDATE tasks SET updated_at = now() WHERE id = $1", [task.id]);
      }
    });
    const [row] = await this.all("SELECT * REPLACE (strftime(created_at, '%Y-%m-%dT%H:%M:%S') AS created_at) FROM feedback WHERE id = $1", [id]);
    return toFeedback(row!);
  }

  /* ------------------------------ Agent runs ------------------------------ */

  async startAgentRun(taskId: string, stage: TaskStatus, kind: string, model: string | null = null): Promise<AgentRun> {
    const id = crypto.randomUUID();
    await this.tx(async () => {
      await this.exec("INSERT INTO agent_runs (id, task_id, stage, kind, status, model) VALUES ($1, $2, $3, $4, 'running', $5)", [id, taskId, stage, kind, model]);
      await this.event(taskId, "run_started", { runId: id, stage, kind, model });
    });
    return (await this.getAgentRun(id))!;
  }

  /** Close a run. Its cost rolls up into the task in the same transaction. */
  async finishAgentRun(
    id: string,
    outcome: { status: Exclude<AgentRunStatus, "running">; costUsd?: number; turns?: number; sessionId?: string | null; output?: unknown; summary?: string | null; logPath?: string | null },
  ): Promise<AgentRun> {
    await this.tx(async () => {
      const [row] = await this.all("SELECT task_id FROM agent_runs WHERE id = $1", [id]);
      if (!row) throw new Error(`Run ${id} not found`);
      const cost = outcome.costUsd ?? 0;
      await this.exec(
        "UPDATE agent_runs SET status = $1, cost_usd = $2, turns = $3, session_id = $4, output = $5, summary = $6, log_path = $7, ended_at = now() WHERE id = $8",
        [outcome.status, cost, outcome.turns ?? 0, outcome.sessionId ?? null, outcome.output === undefined ? null : JSON.stringify(outcome.output), outcome.summary ?? null, outcome.logPath ?? null, id],
      );
      if (cost > 0) await this.exec("UPDATE tasks SET cost_usd = cost_usd + $1 WHERE id = $2", [cost, String(row.task_id)]);
      await this.event(String(row.task_id), "run_finished", { runId: id, status: outcome.status, costUsd: cost });
    });
    return (await this.getAgentRun(id))!;
  }

  async getAgentRun(id: string): Promise<AgentRun | null> {
    const [row] = await this.all(`SELECT * ${RUN_TIMES} FROM agent_runs WHERE id = $1`, [id]);
    return row ? toAgentRun(row) : null;
  }

  async listAgentRuns(taskId?: string, limit = 100): Promise<AgentRun[]> {
    const where = taskId ? "WHERE task_id = $1" : "";
    const rows = await this.all(`SELECT * ${RUN_TIMES} FROM agent_runs ${where} ORDER BY started_at DESC, id LIMIT ${Math.max(1, Math.floor(limit))}`, taskId ? [taskId] : []);
    return rows.map(toAgentRun);
  }

  async hasRunningAgentRun(taskId: string): Promise<boolean> {
    return (await this.all("SELECT 1 FROM agent_runs WHERE task_id = $1 AND status = 'running'", [taskId])).length > 0;
  }

  /* ------------------------------ Plans ------------------------------ */

  async createPlan(source: string, by = "human"): Promise<Plan> {
    const id = crypto.randomUUID();
    await this.exec("INSERT INTO plans (id, source, status, created_by) VALUES ($1, $2, 'running', $3)", [id, source, by]);
    return (await this.getPlan(id))!;
  }

  async getPlan(id: string): Promise<Plan | null> {
    const [row] = await this.all(`SELECT * ${PLAN_TIMES} FROM plans WHERE id = $1`, [id]);
    return row ? toPlan(row) : null;
  }

  async listPlans(limit = 50): Promise<Plan[]> {
    return (await this.all(`SELECT * ${PLAN_TIMES} FROM plans ORDER BY created_at DESC, id LIMIT ${Math.max(1, Math.floor(limit))}`)).map(toPlan);
  }

  async updatePlan(
    id: string,
    patch: { status?: Plan["status"]; specPath?: string | null; attempts?: number; output?: unknown; checks?: unknown; filing?: unknown; prNumber?: number; tasks?: Record<string, string>; error?: string | null },
  ): Promise<void> {
    const sets: string[] = ["updated_at = now()"];
    const params: Param[] = [];
    const set = (column: string, value: Param) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (patch.status !== undefined) set("status", patch.status);
    if (patch.specPath !== undefined) set("spec_path", patch.specPath);
    if (patch.attempts !== undefined) set("attempts", patch.attempts);
    if (patch.output !== undefined) set("output", JSON.stringify(patch.output));
    if (patch.checks !== undefined) set("checks", JSON.stringify(patch.checks));
    if (patch.filing !== undefined) set("filing", JSON.stringify(patch.filing));
    if (patch.prNumber !== undefined) set("pr_number", patch.prNumber);
    if (patch.tasks !== undefined) set("tasks", JSON.stringify(patch.tasks));
    if (patch.error !== undefined) set("error", patch.error);
    params.push(id);
    await this.exec(`UPDATE plans SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
  }

  /* ------------------------------ Leases ------------------------------ */

  /** Take a shared resource (the local environment). False when someone else holds it. */
  async acquireLease(resource: string, taskId: string | null, pid: number | null): Promise<boolean> {
    const rows = await this.all("INSERT INTO leases (resource, task_id, pid) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING resource", [resource, taskId, pid]);
    return rows.length > 0;
  }

  async updateLeasePid(resource: string, pid: number, logPath: string | null = null): Promise<void> {
    await this.exec("UPDATE leases SET pid = $1, log_path = $2 WHERE resource = $3", [pid, logPath, resource]);
  }

  /** `taskId` null: a person holds it (started from the dashboard or the CLI). */
  async getLease(resource: string): Promise<Lease | null> {
    const [row] = await this.all("SELECT task_id, pid, log_path, CAST(acquired_at AS VARCHAR) AS acquired_at FROM leases WHERE resource = $1", [resource]);
    return row
      ? {
          taskId: row.task_id == null ? null : String(row.task_id),
          pid: row.pid == null ? null : Number(row.pid),
          logPath: row.log_path == null ? null : String(row.log_path),
          acquiredAt: String(row.acquired_at),
        }
      : null;
  }

  async releaseLease(resource: string): Promise<void> {
    await this.exec("DELETE FROM leases WHERE resource = $1", [resource]);
  }

  /* ------------------------------ Test runs ------------------------------ */

  async createRun(taskId: string | null): Promise<TestRun> {
    const id = crypto.randomUUID();
    await this.tx(async () => {
      await this.exec("INSERT INTO test_runs (id, task_id, status) VALUES ($1, $2, 'running')", [id, taskId]);
      if (taskId) await this.event(taskId, "test_run_started", { runId: id });
    });
    return (await this.getRun(id))!;
  }

  async finishRun(
    id: string,
    outcome: { status: RunStatus; exitCode: number | null; summary: RunSummary | null; results: TestResult[]; reportPath: string | null },
  ): Promise<TestRun> {
    await this.tx(async () => {
      await this.exec(
        "UPDATE test_runs SET status = $1, exit_code = $2, summary = $3, results = $4, report_path = $5, ended_at = now() WHERE id = $6",
        [outcome.status, outcome.exitCode, outcome.summary ? JSON.stringify(outcome.summary) : null, JSON.stringify(outcome.results), outcome.reportPath, id],
      );
      const [row] = await this.all("SELECT task_id FROM test_runs WHERE id = $1", [id]);
      if (row?.task_id) await this.event(String(row.task_id), "test_run_finished", { runId: id, status: outcome.status, summary: outcome.summary });
    });
    return (await this.getRun(id))!;
  }

  /** Runs left 'running' by a server that died can never finish; mark them as errors on startup. */
  async failInterruptedRuns(): Promise<number> {
    const tests = await this.all("UPDATE test_runs SET status = 'error', ended_at = now() WHERE status = 'running' RETURNING id");
    const agents = await this.all("UPDATE agent_runs SET status = 'error', summary = 'The factory stopped during this run', ended_at = now() WHERE status = 'running' RETURNING id");
    return tests.length + agents.length;
  }

  async listRuns(limit = 50): Promise<TestRun[]> {
    return (await this.all(`SELECT * ${RUN_TIMES} FROM test_runs ORDER BY started_at DESC LIMIT ${Math.max(1, Math.floor(limit))}`)).map(toRun);
  }

  async getRun(id: string): Promise<TestRun | null> {
    const [row] = await this.all(`SELECT * ${RUN_TIMES} FROM test_runs WHERE id = $1`, [id]);
    return row ? toRun(row) : null;
  }

  async getRunResults(id: string): Promise<TestResult[]> {
    const [row] = await this.all("SELECT results FROM test_runs WHERE id = $1", [id]);
    return row?.results ? (JSON.parse(String(row.results)) as TestResult[]) : [];
  }

  async listLearnings(): Promise<Learning[]> {
    const rows = await this.all(`SELECT * REPLACE (strftime(created_at, '%Y-%m-%dT%H:%M:%S') AS created_at, strftime(applied_at, '%Y-%m-%dT%H:%M:%S') AS applied_at)
      FROM learnings ORDER BY created_at DESC, id`);
    return rows.map(toLearning);
  }

  async getLearning(id: string): Promise<Learning | null> {
    const [row] = await this.all(
      "SELECT * REPLACE (strftime(created_at, '%Y-%m-%dT%H:%M:%S') AS created_at, strftime(applied_at, '%Y-%m-%dT%H:%M:%S') AS applied_at) FROM learnings WHERE id = $1",
      [id],
    );
    return row ? toLearning(row) : null;
  }

  /** The retro's proposals for a task, open until a person decides. */
  async addLearnings(taskId: string, items: Array<{ kind: LearningKind; summary: string; target: string | null; evidence: string[] }>): Promise<Learning[]> {
    const ids: string[] = [];
    await this.tx(async () => {
      for (const l of items) {
        const id = crypto.randomUUID();
        ids.push(id);
        await this.exec("INSERT INTO learnings (id, source_task_id, source, category, summary, target, evidence) VALUES ($1, $2, 'retro', $3, $4, $5, $6)", [
          id,
          taskId,
          l.kind,
          l.summary,
          l.target,
          JSON.stringify(l.evidence),
        ]);
      }
      if (items.length) await this.event(taskId, "learnings_proposed", { count: items.length, ids });
    });
    return Promise.all(ids.map(async (id) => (await this.getLearning(id))!));
  }

  /** A person edits a learning, or approves or rejects it. An applied learning does not change. */
  async updateLearning(id: string, change: UpdateLearningInput, by = "human"): Promise<Learning | null> {
    const current = await this.getLearning(id);
    if (!current) return null;
    if (current.appliedAt) throw new Error("This learning is already applied");
    const next = { ...current, ...change };
    await this.tx(async () => {
      await this.exec("UPDATE learnings SET summary = $1, category = $2, target = $3, status = $4 WHERE id = $5", [
        next.summary,
        next.kind,
        next.kind === "codebase" ? (next.target ?? "CLAUDE.md") : null,
        next.status,
        id,
      ]);
      await this.event(current.sourceTaskId, "learning_updated", { learningId: id, ...change, by });
    });
    return this.getLearning(id);
  }

  async markLearningApplied(id: string, appliedTo: string): Promise<void> {
    await this.exec("UPDATE learnings SET promoted_to = $1, applied_at = now() WHERE id = $2", [appliedTo, id]);
  }
}

/** Blockers of `t` and whether it is ready: in a factory stage with every blocker done. */
const DEPS_COLUMNS = `
  coalesce((SELECT list(d.blocked_by ORDER BY d.blocked_by) FROM task_deps d WHERE d.task_id = t.id), []::VARCHAR[]) AS blocked_by,
  (t.status NOT IN ('done', 'escalated') AND NOT EXISTS (
    SELECT 1 FROM task_deps d JOIN tasks b ON b.id = d.blocked_by WHERE d.task_id = t.id AND b.status <> 'done')) AS ready`;

const PLAN_TIMES = "REPLACE (strftime(created_at, '%Y-%m-%dT%H:%M:%S') AS created_at, strftime(updated_at, '%Y-%m-%dT%H:%M:%S') AS updated_at)";

function jsonOrNull(value: unknown): unknown {
  return typeof value === "string" ? (JSON.parse(value) as unknown) : null;
}

function toPlan(r: Row): Plan {
  return {
    id: String(r.id),
    source: String(r.source),
    status: r.status as Plan["status"],
    specPath: r.spec_path == null ? null : String(r.spec_path),
    attempts: Number(r.attempts ?? 0),
    output: jsonOrNull(r.output),
    checks: jsonOrNull(r.checks) as Plan["checks"],
    filing: jsonOrNull(r.filing) as Plan["filing"],
    prNumber: r.pr_number == null ? null : Number(r.pr_number),
    tasks: (jsonOrNull(r.tasks) as Plan["tasks"] | null) ?? {},
    error: r.error == null ? null : String(r.error),
    by: String(r.created_by),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

const RUN_TIMES = "REPLACE (strftime(started_at, '%Y-%m-%dT%H:%M:%S') AS started_at, strftime(ended_at, '%Y-%m-%dT%H:%M:%S') AS ended_at)";

function toRun(r: Row): TestRun {
  return {
    id: String(r.id),
    taskId: r.task_id == null ? null : String(r.task_id),
    status: r.status as RunStatus,
    startedAt: String(r.started_at),
    endedAt: r.ended_at == null ? null : String(r.ended_at),
    exitCode: r.exit_code == null ? null : Number(r.exit_code),
    summary: r.summary ? (JSON.parse(String(r.summary)) as RunSummary) : null,
    reportUrl: r.report_path ? artifactUrl(String(r.report_path)) : null,
  };
}

function toSummary(r: Row): TaskSummary {
  return {
    id: String(r.id),
    title: String(r.title),
    ticketKey: r.ticket_key == null ? null : String(r.ticket_key),
    status: r.status as TaskStatus,
    attempts: Number(r.attempts ?? 0),
    costUsd: Number(r.cost_usd ?? 0),
    blockedBy: Array.isArray(r.blocked_by) ? (r.blocked_by as string[]) : typeof r.blocked_by === "string" ? (JSON.parse(r.blocked_by) as string[]) : [],
    ready: Boolean(r.ready),
    screenshotCount: Number(r.screenshot_count ?? 0),
    updatedAt: String(r.updated_at),
    durationSec: Math.max(0, Math.round(Number(r.duration_sec ?? 0))),
    durationFinal: Boolean(r.duration_final),
  };
}

function toTask(r: Row): Task {
  return {
    ...toSummary(r),
    description: String(r.description),
    phaseModels: parseJson(r.phase_models) as Task["phaseModels"],
    branch: r.branch == null ? null : String(r.branch),
    worktree: r.worktree == null ? null : String(r.worktree),
    prNumber: r.pr_number == null ? null : Number(r.pr_number),
    context: parseJson(r.context) as TaskContext,
    createdAt: String(r.created_at),
  };
}

function toAgentRun(r: Row): AgentRun {
  return {
    id: String(r.id),
    taskId: String(r.task_id),
    stage: r.stage as TaskStatus,
    kind: String(r.kind),
    status: r.status as AgentRunStatus,
    model: r.model == null ? null : String(r.model),
    costUsd: Number(r.cost_usd ?? 0),
    turns: Number(r.turns ?? 0),
    summary: r.summary == null ? null : String(r.summary),
    output: typeof r.output === "string" ? (JSON.parse(r.output) as unknown) : null,
    logPath: r.log_path == null ? null : String(r.log_path),
    startedAt: String(r.started_at),
    endedAt: r.ended_at == null ? null : String(r.ended_at),
  };
}

/** Merge a patch into a task context; keys set to undefined are removed. */
export function mergeContext(current: TaskContext, patch: Partial<TaskContext>): TaskContext {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as TaskContext;
}

function toArtifact(r: Row): Artifact {
  const path = String(r.path);
  return {
    id: String(r.id),
    taskId: String(r.task_id),
    kind: r.kind as Artifact["kind"],
    path,
    url: artifactUrl(path),
    label: String(r.label ?? ""),
    createdAt: String(r.created_at),
  };
}

function toFeedback(r: Row): Feedback {
  return {
    id: String(r.id),
    taskId: String(r.task_id),
    decision: r.decision as Decision,
    comment: String(r.comment ?? ""),
    artifactId: r.artifact_id == null ? null : String(r.artifact_id),
    createdAt: String(r.created_at),
  };
}

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toLearning(r: Row): Learning {
  const evidence = typeof r.evidence === "string" ? (JSON.parse(r.evidence) as unknown) : r.evidence;
  return {
    id: String(r.id),
    sourceTaskId: String(r.source_task_id),
    source: String(r.source),
    kind: r.category === "codebase" ? "codebase" : "factory",
    summary: String(r.summary),
    target: r.target == null ? null : String(r.target),
    evidence: Array.isArray(evidence) ? evidence.map(String) : [],
    status: (["open", "approved", "rejected"].includes(String(r.status)) ? String(r.status) : "open") as Learning["status"],
    appliedTo: r.promoted_to == null ? null : String(r.promoted_to),
    appliedAt: r.applied_at == null ? null : String(r.applied_at),
    createdAt: String(r.created_at),
  };
}

