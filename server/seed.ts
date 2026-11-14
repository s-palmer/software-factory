/**
 * Seeds demo tasks: one escalated (with a reason, questions and every PNG in <FACTORY_ARTIFACTS>/screenshots),
 * one in implementing with agent runs, one in the backlog and one done.
 * Stand-in for the orchestrator's own data. Usage: pnpm factory:seed [--reset]
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TaskStatus } from "../shared/lifecycle";
import { DEFAULT_PHASE_MODELS, MODELS, modelFor, type Phase, type PhaseModels } from "../shared/models";
import { FactoryDb } from "./db";

const dbPath = process.env.FACTORY_DB ?? "data/factory.duckdb";
const artifactDir = process.env.FACTORY_ARTIFACTS ?? "artifacts";

if (process.argv.includes("--reset")) {
  for (const f of [dbPath, `${dbPath}.wal`]) rmSync(f, { force: true });
}

mkdirSync(dirname(dbPath), { recursive: true });
const db = await FactoryDb.open(dbPath);

/**
 * Record a finished agent run (or factory check) so the dashboard has history to show. Only finished runs:
 * the API marks every still-running run as interrupted (error) when it starts.
 */
async function run(
  taskId: string,
  stage: TaskStatus,
  kind: string,
  /** The task's overrides for an agent run; null for a factory check (no model). */
  overrides: PhaseModels | null,
  outcome: { status: "passed" | "failed"; costUsd?: number; turns?: number; summary?: string },
) {
  const phase = (kind === "decider" ? "decider" : stage) as Phase;
  const model = overrides ? modelFor(phase, DEFAULT_PHASE_MODELS, overrides) : null;
  const started = await db.startAgentRun(taskId, stage, kind, model);
  await db.finishAgentRun(started.id, { status: outcome.status, costUsd: outcome.costUsd ?? 0, turns: outcome.turns ?? 0, summary: outcome.summary ?? null });
}

// 1. Escalated: implement failed three times; waits for a decision.
const demo = await db.createTask(
  { title: "Demo: verify the task board", description: "Seeded task with screenshots from the last browser run.", ticketKey: "#1" },
  "escalated",
  "seed",
);
const shotsDir = join(artifactDir, "screenshots");
const shots = existsSync(shotsDir) ? readdirSync(shotsDir).filter((f) => f.endsWith(".png")).sort() : [];
for (const file of shots) {
  await db.addArtifact(demo.id, { kind: "screenshot", path: `screenshots/${file}`, label: file.replace(/\.png$/, "") });
}
await run(demo.id, "scoping", "agent", {}, { status: "passed", costUsd: 0.38, turns: 9, summary: "Wrote the solution doc with 2 acceptance criteria." });
await run(demo.id, "design", "agent", {}, { status: "passed", costUsd: 0.21, turns: 6, summary: "Planned 3 tasks and a browser check of the board." });
await run(demo.id, "test_writing", "agent", {}, { status: "passed", costUsd: 0.64, turns: 14, summary: "Added 2 failing tests; locked." });
for (let i = 1; i <= 3; i++) {
  await run(demo.id, "implementing", "agent", {}, { status: "passed", costUsd: 0.9, turns: 22, summary: `Attempt ${i}: changed TaskBoard.tsx.` });
  await run(demo.id, "implementing", "gate", null, { status: "failed", summary: "Locked test 'AC-2 empty board shows a hint' still fails." });
}
await db.updateTask(demo.id, {
  attempts: 3,
  branch: "factory/1-verify-task-board",
  context: {
    needsBrowser: true,
    codeExists: true,
    escalatedFrom: "implementing",
    escalation: "Implement failed 3 times: the locked test 'AC-2 empty board shows a hint' still fails (expected 'No tasks yet', got '').",
    questions: ["Should the empty-board hint also show when a filter hides every task?", "May the implementer change the e2e fixture data?"],
    risk: { level: "high", reasons: ["Changes the browser tests that judge the work"] },
  },
});

// 3. Implementing, mid-flight, with the implementer overridden to Sonnet.
const tidyModels: PhaseModels = { implementing: MODELS.sonnet };
const tidy = await db.createTask({ title: "Tidy dashboard spacing", description: "Small CSS-only change.", ticketKey: "#3", phaseModels: tidyModels }, "implementing", "seed");
await run(tidy.id, "backlog", "worktree", null, { status: "passed", summary: "Created worktree and branch factory/3-tidy-spacing." });
await run(tidy.id, "scoping", "agent", tidyModels, { status: "passed", costUsd: 0.05, turns: 4, summary: "One acceptance criterion: consistent 16px gutters." });
await run(tidy.id, "scoping", "decider", tidyModels, { status: "passed", costUsd: 0.01, turns: 1, summary: "Answered 1 question." });
await run(tidy.id, "design", "agent", tidyModels, { status: "passed", costUsd: 0.03, turns: 3, summary: "One task; browser check of the home page." });
await run(tidy.id, "test_writing", "agent", tidyModels, { status: "passed", costUsd: 0.04, turns: 5, summary: "Added a layout test." });
await run(tidy.id, "test_writing", "red-check", null, { status: "passed", summary: "The new test fails as expected; locked." });
await run(tidy.id, "implementing", "agent", tidyModels, { status: "passed", costUsd: 0.06, turns: 8, summary: "Attempt 1: set the gutters in styles.css." });
await run(tidy.id, "implementing", "gate", null, { status: "failed", summary: "Lint failed: unused selector .home__gutter." });
await db.updateTask(tidy.id, {
  attempts: 1,
  branch: "factory/3-tidy-spacing",
  context: {
    needsBrowser: true,
    decisions: [{ stage: "scoping", question: "Should the task page get the same gutters as the home page?", answer: "Yes: one gutter everywhere." }],
    risk: { level: "low", reasons: [] },
  },
});

// 2. Backlog, waiting for #3 to be merged.
await db.createTask({ title: "Add a learnings page to the dashboard", description: "", ticketKey: "#2", blockedBy: ["#3"] }, "backlog", "seed");

// 4. Done, without a browser check.
const readme = await db.createTask({ title: "Document the factory CLI", description: "README section for bin/factory.", ticketKey: "#4", }, "done", "seed");
await run(readme.id, "scoping", "agent", {}, { status: "passed", costUsd: 0.12, turns: 5, summary: "Docs-only change." });
await run(readme.id, "implementing", "agent", {}, { status: "passed", costUsd: 0.31, turns: 11, summary: "Wrote the CLI section." });
await run(readme.id, "pr", "publish", null, { status: "passed", summary: "Opened PR #42." });
await run(readme.id, "awaiting_merge", "merge", null, { status: "passed", summary: "Merged PR #42." });
await db.updateTask(readme.id, { attempts: 1, branch: "factory/4-cli-docs", prNumber: 42, context: { needsBrowser: false, risk: { level: "low", reasons: [] } } });

db.close();
console.log(`seeded 4 tasks (escalated demo ${demo.id} with ${shots.length} screenshot(s)) into ${dbPath}`);
