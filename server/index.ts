/**
 * Starts the factory API. Env: FACTORY_DB (default data/factory.duckdb), FACTORY_ARTIFACTS (default artifacts),
 * API_PORT (default 8787), FACTORY_TEST_COMMAND (default: pnpm exec playwright test).
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { createEffects } from "./effects";
import { Orchestrator } from "./orchestrator";
import { ghTracker, Planner } from "./planning/pm";
import { Conductor } from "./conductor";
import { FactoryDb } from "./db";
import { TestRunner } from "./runner";

const dbPath = process.env.FACTORY_DB ?? "data/factory.duckdb";
const artifactDir = process.env.FACTORY_ARTIFACTS ?? "artifacts";
const port = Number(process.env.API_PORT ?? 8787);

if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
const db = await FactoryDb.open(dbPath);
const interrupted = await db.failInterruptedRuns();
if (interrupted > 0) console.log(`marked ${interrupted} interrupted test run(s) as errors`);
// FACTORY_TEST_COMMAND overrides the suite command (space-separated), e.g. for a fake runner in tests.
const command = process.env.FACTORY_TEST_COMMAND?.split(" ").filter(Boolean);
const runner = new TestRunner(db, { artifactRoot: artifactDir, command });
// The project config (factory.config.json in the target repository). An invalid file stops the server.
const config = loadConfig();
const policy = config.policy;

// The orchestrator: on by default, the loop paused until started (dashboard switch or `factory start`).
let orchestrator: Orchestrator | undefined;
let planner: Planner | undefined;
if (config.enabled) {
  if (!existsSync(config.chromium)) {
    console.error(`Chromium for the browser check is missing at ${config.chromium}. Run: pnpm exec playwright install chromium`);
    process.exit(1);
  }
  const effects = createEffects(config.effects);
  orchestrator = new Orchestrator(db, effects, { ...config.orchestrator, policy, baseBranch: config.effects.base });
  planner = new Planner(db, effects, ghTracker(config.effects.repo), {
    projectDir: config.effects.projectDir,
    base: config.effects.base,
    maxAttempts: config.orchestrator.maxAttempts,
    artifactRoot: config.orchestrator.artifactRoot,
    dryRun: process.env.FACTORY_DRY_RUN_PLAN === "1",
  });
  // Optional reference agents, off by default: an external PM / orchestrator drives the factory through the CLI
  // (docs/INTERFACE.md). FACTORY_INTAKE_POLL_MS turns on intake polling, FACTORY_CONDUCTOR_MS the built-in conductor.
  const intake = planner;
  const loop = orchestrator;
  const intakeMs = Number(process.env.FACTORY_INTAKE_POLL_MS ?? 0);
  if (intakeMs > 0) {
    setInterval(() => {
      if (loop.running) intake.pollIntake().catch((error: unknown) => console.error("[factory] intake poll failed:", error));
    }, intakeMs).unref();
  }
  const conductorMs = Number(process.env.FACTORY_CONDUCTOR_MS ?? 0);
  if (conductorMs > 0) {
    const conductor = new Conductor(db, effects, { cwd: process.cwd(), artifactRoot: config.orchestrator.artifactRoot, apiUrl: `http://127.0.0.1:${port}` });
    setInterval(() => {
      if (loop.running) conductor.run().catch((error: unknown) => console.error("[factory] conductor failed:", error));
    }, conductorMs).unref();
  }
  // Restart safety: an environment lease left by a stopped server is freed, and its process group stopped.
  const lease = await db.getLease("env");
  if (lease) {
    if (lease.pid) await effects.env.stop(lease.pid);
    await db.releaseLease("env");
    console.log(`freed a stale environment lease (task ${lease.taskId ?? "-"}, pid ${lease.pid ?? "-"})`);
  }
  if (config.autostart) orchestrator.start();
  console.log(
    `orchestrator ${orchestrator.running ? "running" : "paused"}: repo ${config.effects.repo}, base ${config.effects.remote}/${config.effects.base}, project ${config.effects.projectDir || "."}, config ${config.configFile ?? "(defaults)"}, home ${config.effects.home}`,
  );
} else {
  console.log("orchestrator off (FACTORY_ORCHESTRATOR=0)");
}
const app = createApp(db, { runner, policy, orchestrator, planner });
app.use("/artifacts/*", serveStatic({ root: artifactDir, rewriteRequestPath: (p) => p.replace(/^\/artifacts/, "") }));

// Loopback only: the API has no auth of its own; reach it through the Vite proxy.
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => console.log(`factory API on http://127.0.0.1:${port} (db: ${dbPath}, artifacts: ${artifactDir})`));
