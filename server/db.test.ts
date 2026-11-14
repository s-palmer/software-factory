// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactoryDb } from "./db";

let db: FactoryDb;
beforeEach(async () => {
  db = await FactoryDb.open(":memory:");
});
afterEach(() => db.close());

describe("concurrency", () => {
  it("runs overlapping transactions one at a time instead of interleaving them", async () => {
    const tasks = await Promise.all(Array.from({ length: 25 }, (_, i) => db.createTask({ title: `t${i}`, description: "" }, "escalated")));
    // Interleave writes and reads on the same tasks.
    await Promise.all(
      tasks.flatMap((t, i) => [
        db.addArtifact(t.id, { kind: "screenshot", path: `screenshots/${i}.png`, label: "" }),
        db.recordFeedback(t, { decision: "request_changes", comment: `fix ${i}`, artifactId: null }, "implementing"),
        db.listTasks(),
      ]),
    );
    const list = await db.listTasks();
    expect(list).toHaveLength(25);
    expect(list.every((t) => t.status === "implementing" && t.screenshotCount === 1)).toBe(true);
    const contexts = await Promise.all(tasks.map(async (t) => (await db.getTask(t.id))!.context.feedback));
    expect(contexts.every((f, i) => f?.[0] === `A person asked for changes: fix ${i}`)).toBe(true);
  });

  it("rolls back a failed transaction without blocking later ones", async () => {
    const task = await db.createTask({ title: "x", description: "" });
    // artifact_id is a VARCHAR; an object can't be bound, so this transaction fails mid-way.
    await expect(db.recordFeedback(task, { decision: "comment", comment: "c", artifactId: {} as unknown as string }, task.status)).rejects.toThrow("Cannot create values of type ANY");
    expect((await db.getTaskDetail(task.id))?.feedback).toEqual([]);
    await db.recordFeedback(task, { decision: "comment", comment: "ok", artifactId: null }, task.status);
    expect((await db.getTaskDetail(task.id))?.feedback).toHaveLength(1);
  });
});

describe("test runs", () => {
  it("marks runs interrupted by a restart as errors", async () => {
    const run = await db.createRun(null);
    expect(await db.failInterruptedRuns()).toBe(1);
    expect((await db.getRun(run.id))?.status).toBe("error");
  });
});

describe("migrations", () => {
  it("brings an older database up to the current schema, maps old stages, and is a no-op the second time", async () => {
    const { DuckDBInstance } = await import("@duckdb/node-api");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "factory-mig-"));
    const file = join(dir, "old.duckdb");
    try {
      // The first tasks table, with rows in old stages that had human gates.
      const inst = await DuckDBInstance.create(file);
      const conn = await inst.connect();
      await conn.run(`CREATE TABLE tasks (id VARCHAR PRIMARY KEY, title VARCHAR NOT NULL, description VARCHAR NOT NULL DEFAULT '', status VARCHAR NOT NULL,
        acceptance_criteria JSON, file_plan JSON, locked_files JSON, created_at TIMESTAMP NOT NULL DEFAULT now(), updated_at TIMESTAMP NOT NULL DEFAULT now())`);
      await conn.run("INSERT INTO tasks (id, title, status) VALUES ('old-1', 'Legacy task', 'backlog'), ('old-2', 'Gated', 'awaiting_merge_approval')");
      conn.closeSync();
      inst.closeSync();

      const migrated = await FactoryDb.open(file);
      expect(await migrated.getTask("old-1")).toMatchObject({ attempts: 0, costUsd: 0, context: {}, phaseModels: {} });
      expect((await migrated.getTask("old-2"))?.status).toBe("pr");
      expect((await migrated.setModels("old-1", { phaseModels: { pr: "claude-sonnet-5-5" } }))?.phaseModels).toEqual({ pr: "claude-sonnet-5-5" });
      migrated.close();
      const again = await FactoryDb.open(file);
      expect((await again.getTask("old-1"))?.phaseModels).toEqual({ pr: "claude-sonnet-5-5" });
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
