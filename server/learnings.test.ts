// @vitest-environment node
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactoryDb } from "./db";
import { applyLearnings } from "./learnings";

let db: FactoryDb;
beforeEach(async () => {
  db = await FactoryDb.open(":memory:");
});
afterEach(() => db.close());

describe("applying learnings", () => {
  it("adds factory learnings to the file and turns codebase ones into tasks, once", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "factory-learnings-")), "learnings.md");
    const source = await db.createTask({ title: "Paginate", description: "" });
    const [factory, codebase, open] = await db.addLearnings(source.id, [
      { kind: "factory", summary: "Run the tests with pnpm test.", target: null, evidence: ["jest was denied"] },
      { kind: "codebase", summary: "Dropdowns mark the selected option with a background colour.", target: "AGENTS.md", evidence: ["review asked for it"] },
      { kind: "factory", summary: "Not approved, so not applied.", target: null, evidence: [] },
    ]);
    await db.updateLearning(factory!.id, { status: "approved" });
    await db.updateLearning(codebase!.id, { status: "approved" });

    const result = await applyLearnings(db, file);
    expect(result.factory).toBe(1);
    expect(result.tasks).toHaveLength(1);
    expect(readFileSync(file, "utf8")).toBe("- Run the tests with pnpm test.\n");
    const task = (await db.getTask(result.tasks[0]!.taskId))!;
    expect(task.title).toBe("Add to AGENTS.md: Dropdowns mark the selected option with a background colour.");
    expect(task.description).toContain("review asked for it");
    expect(task.status).toBe("backlog");

    const after = await db.listLearnings();
    expect(after.find((l) => l.id === codebase!.id)).toMatchObject({ appliedTo: `task:${task.id}` });
    expect(after.find((l) => l.id === open!.id)?.appliedAt).toBeNull();
    expect(await applyLearnings(db, file)).toEqual({ factory: 0, tasks: [] });
    await expect(db.updateLearning(factory!.id, { summary: "changed" })).rejects.toThrow(/already applied/);
  });
});
