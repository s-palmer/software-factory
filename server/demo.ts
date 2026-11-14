/**
 * Makes the README's screenshots from made-up data, so no real task shows. It builds a throwaway factory home for an
 * imaginary recipe app ("Larder"), draws that app's before-and-after pictures, seeds tasks in every stage, runs the
 * API and the built dashboard on spare ports, and photographs the pages into docs/screenshots/.
 * Usage: pnpm docs:screenshots
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "@playwright/test";
import type { Task } from "../shared/api";
import type { TaskStatus } from "../shared/lifecycle";
import { DEFAULT_PHASE_MODELS, modelFor, type Phase } from "../shared/models";
import { FactoryDb } from "./db";
import { docPaths } from "./phases";

const API_PORT = 8797;
const WEB_PORT = 4181;
const OUT = resolve("docs/screenshots");
const root = mkdtempSync(join(tmpdir(), "factory-demo-"));
const repo = join(root, "larder");
const home = join(root, "home");
const artifacts = join(home, "artifacts");

/* ------------------------------ The imaginary app ------------------------------ */

const page = (body: string) => `<!doctype html><html><head><style>
  body { font: 15px system-ui, sans-serif; margin: 0; background: #fffaf3; color: #2b2b2b; }
  header { background: #2f5d50; color: #fff; padding: 14px 24px; font-weight: 600; font-size: 18px; }
  main { padding: 24px; max-width: 760px; }
  h1 { font-size: 22px; margin: 0 0 16px; }
  ul { list-style: none; padding: 0; margin: 0 0 16px; }
  li { background: #fff; border: 1px solid #eadfcc; border-radius: 8px; padding: 10px 14px; margin-bottom: 8px; display: flex; justify-content: space-between; }
  button { background: #2f5d50; color: #fff; border: 0; border-radius: 6px; padding: 8px 14px; font-size: 14px; }
  .dialog { margin-top: 12px; background: #fff; border: 1px solid #2f5d50; border-radius: 8px; padding: 12px 14px; }
</style></head><body><header>Larder</header><main>${body}</main></body></html>`;

const list = `<ul>${["Flour, 500 g", "Eggs, 6", "Butter, 250 g", "Lemons, 2"].map((i) => `<li><span>${i}</span><span>☐</span></li>`).join("")}</ul>`;

const PICTURES: Record<string, string> = {
  "list-before": page(`<h1>Shopping list</h1>${list}`),
  "list-before-2": page(`<h1>Shopping list</h1>${list}`),
  "list-button": page(`<h1>Shopping list</h1>${list}<button>Export list</button>`),
  "list-copied": page(`<h1>Shopping list</h1>${list}<button>Export list</button><div class="dialog">Copied 4 items to the clipboard.</div>`),
};

async function drawPictures(p: Page): Promise<void> {
  mkdirSync(join(artifacts, "demo"), { recursive: true });
  await p.setViewportSize({ width: 820, height: 460 });
  for (const [name, html] of Object.entries(PICTURES)) {
    await p.setContent(html);
    await p.screenshot({ path: join(artifacts, "demo", `${name}.png`) });
  }
}

/* ------------------------------ The tasks ------------------------------ */

async function seed(): Promise<void> {
  const db = await FactoryDb.open(join(home, "factory.duckdb"));
  // The database's own clock decides how long a task took, so the seed moves start times back.
  const raw = db as unknown as { exec(sql: string, params: unknown[]): Promise<void> };
  const startedAgo = (id: string, minutes: number) => raw.exec("UPDATE tasks SET created_at = now()::TIMESTAMP - to_minutes($1::BIGINT) WHERE id = $2", [minutes, id]);
  const run = async (taskId: string, stage: TaskStatus, kind: string, status: "passed" | "failed", costUsd: number, summary: string) => {
    const phase = (kind === "decider" ? "decider" : stage) as Phase;
    const started = await db.startAgentRun(taskId, stage, kind, kind === "agent" || kind === "decider" ? modelFor(phase, DEFAULT_PHASE_MODELS, {}) : null);
    await db.finishAgentRun(started.id, { status, costUsd, turns: Math.round(costUsd * 20) + 2, summary });
  };
  const early = async (id: string) => {
    await run(id, "scoping", "agent", "passed", 0.42, "Wrote the solution doc with 2 acceptance criteria.");
    await run(id, "design", "agent", "passed", 0.31, "Planned 3 tasks and a browser check.");
    await run(id, "test_writing", "agent", "passed", 0.66, "Added 2 failing tests.");
    await run(id, "test_writing", "red-check", "passed", 0, "The new tests fail before the change; locked.");
  };
  const task = (key: string, title: string, status: TaskStatus, blockedBy: string[] = []): Promise<Task> =>
    db.createTask({ title, description: "", ticketKey: key, blockedBy }, status, "agent:pm");

  for (const [key, title, minutes] of [
    ["#38", "Remember the last servings choice", 34],
    ["#39", "Metric and imperial units on recipes", 51],
    ["#40", "Fix the timer reset on page change", 22],
  ] as const) {
    const t = await task(key, title, "done");
    await early(t.id);
    await run(t.id, "implementing", "agent", "passed", 1.12, "Made the locked tests pass.");
    await run(t.id, "implementing", "gate", "passed", 0, "Lint, types and tests pass against the merge base.");
    await run(t.id, "reviewing", "agent", "passed", 0.38, "Approved.");
    await db.updateTask(t.id, { prNumber: 120 + Number(key.slice(1)) - 37, context: { risk: { level: "low", reasons: [] } } });
    await startedAgo(t.id, minutes);
  }

  // Ready for the merge agent, with before-and-after pictures.
  const exp = await task("#41", "Export the shopping list", "awaiting_merge");
  await early(exp.id);
  await run(exp.id, "implementing", "agent", "passed", 1.37, "Added the Export button and copy to clipboard.");
  await run(exp.id, "implementing", "gate", "passed", 0, "Lint, types and tests pass against the merge base.");
  await run(exp.id, "reviewing", "agent", "passed", 0.44, "Approved: small, covered by the locked tests.");
  await run(exp.id, "browser_check", "agent", "passed", 0.71, "Both criteria pass in the running app.");
  await run(exp.id, "pr", "publish", "passed", 0, "Opened draft PR #124.");
  // Where the browser check keeps them: one run folder for the change, one for the merge base.
  for (const [run, file, label] of [
    ["base", "list-before", "BEFORE: The shopping list has an Export button"],
    ["check", "list-button", "AFTER: PASS: The shopping list has an Export button"],
    ["base", "list-before-2", "BEFORE: Export copies every item to the clipboard"],
    ["check", "list-copied", "AFTER: PASS: Export copies every item to the clipboard"],
  ] as const) {
    const path = `tasks/${exp.id}/${run}/screenshots/${file}.png`;
    mkdirSync(join(artifacts, path, ".."), { recursive: true });
    copyFileSync(join(artifacts, "demo", `${file}.png`), join(artifacts, path));
    await db.addArtifact(exp.id, { kind: "screenshot", path, label });
  }
  await db.updateTask(exp.id, {
    prNumber: 124,
    branch: "factory/issue-41-export-the-shopping-list",
    context: {
      needsBrowser: true,
      risk: { level: "low", reasons: [] },
      decisions: [{ stage: "scoping", question: "Plain text or CSV?", answer: "Plain text, one item per line: it pastes into any notes app." }],
      followUps: ["Export as a file for people who print the list"],
    },
  });
  await db.recordEvent(exp.id, "pr_ready", { pr: 124, headSha: "4f2c9e1", risk: "low" });
  await startedAgo(exp.id, 47);

  // In the browser check now.
  const time = await task("#42", "Show cooking time on recipe cards", "browser_check");
  await early(time.id);
  await run(time.id, "implementing", "agent", "passed", 0.94, "Added the time to RecipeCard.");
  await run(time.id, "implementing", "gate", "passed", 0, "Lint, types and tests pass against the merge base.");
  await run(time.id, "reviewing", "agent", "passed", 0.36, "Approved.");
  await db.updateTask(time.id, { context: { needsBrowser: true, risk: { level: "low", reasons: [] } } });
  await startedAgo(time.id, 31);

  // Waiting at the design gate the task asked for, with the task list to read.
  const search = await task("#43", "Search recipes by ingredient", "awaiting_approval");
  await run(search.id, "scoping", "agent", "passed", 0.48, "Wrote the solution doc with 3 acceptance criteria.");
  await run(search.id, "design", "agent", "passed", 0.35, "Planned 4 tasks; the search runs on the server.");
  const worktree = join(root, "worktrees", "search");
  const doc = join(worktree, docPaths(search).tasks);
  mkdirSync(join(doc, ".."), { recursive: true });
  writeFileSync(
    doc,
    `# Search recipes by ingredient: tasks

1. Add \`GET /api/recipes?ingredient=\` that matches ingredient names, case-insensitive.
2. Add a search box above the recipe grid; search after 300 ms without typing.
3. Show "No recipes use <ingredient>" when nothing matches.
4. Browser check: search "lemon" shows Lemon drizzle only.
`,
  );
  await db.updateTask(search.id, { worktree, context: { gates: ["design"], gateStage: "design", needsBrowser: true } });
  await startedAgo(search.id, 12);

  // Steered while it works.
  const share = await task("#44", "Share a shopping list by link", "implementing");
  await early(share.id);
  await run(share.id, "implementing", "agent", "failed", 0.88, "Attempt 1: added the share link.");
  await run(share.id, "implementing", "gate", "failed", 0, "The locked test 'AC-2 a link expires after 7 days' fails.");
  await db.updateTask(share.id, {
    attempts: 1,
    context: {
      needsBrowser: true,
      steering: [{ note: "Use the existing token helper in src/lib/tokens.ts; do not add a new library.", by: "human", at: new Date().toISOString() }],
      feedback: ["The locked test 'AC-2 a link expires after 7 days' fails."],
    },
  });
  await startedAgo(share.id, 19);

  // Escalated: the decider says stored data needs a person.
  const rate = await task("#45", "Let people rate recipes", "escalated");
  await run(rate.id, "scoping", "agent", "passed", 0.51, "Wrote the solution doc; ratings need a new table.");
  await run(rate.id, "scoping", "decider", "passed", 0.06, "One question needs a person: it stores data per user.");
  await db.updateTask(rate.id, {
    context: {
      escalatedFrom: "scoping",
      escalation: "A question needs a person: ratings are stored per user, which needs a migration and a retention rule.",
      questions: ["How long do we keep a rating after its account is deleted?"],
      risk: { level: "high", reasons: ["Adds a database migration"] },
    },
  });
  await startedAgo(rate.id, 9);

  // Waiting for #42 to merge.
  await task("#46", "Dark mode for the recipe page", "backlog", ["#42"]);

  await db.addLearnings(exp.id, [
    {
      kind: "factory",
      summary: "Run the app's tests with pnpm test, not vitest directly: the script sets the test database.",
      target: null,
      evidence: ["The first implement run called vitest and every database test failed."],
    },
    {
      kind: "codebase",
      summary: "New UI copy goes in src/copy/en.ts, so it can be translated.",
      target: "CLAUDE.md",
      evidence: ["The reviewer asked to move the button label into en.ts."],
    },
  ]);
  db.close();
}

/* ------------------------------ Servers and pictures ------------------------------ */

const LOG = join(tmpdir(), "factory-demo.log");
function start(command: string[], env: Record<string, string>): ChildProcess {
  const log = openSync(LOG, "a");
  return spawn(command[0]!, command.slice(1), { env: { ...process.env, ...env }, stdio: ["ignore", log, log], detached: true });
}

async function waitFor(url: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not come up`);
}

/** One screen of the page, or only `part` of it. */
async function shoot(p: Page, path: string, name: string, wait: string, part?: string): Promise<void> {
  await p.goto(`http://localhost:${WEB_PORT}${path}`);
  await p.locator(wait).first().waitFor();
  await p.waitForTimeout(500);
  const file = join(OUT, `${name}.png`);
  if (part) await p.locator(part).first().screenshot({ path: file });
  else await p.screenshot({ path: file });
  console.log(`docs/screenshots/${name}.png`);
}

mkdirSync(repo, { recursive: true });
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
execFileSync("git", ["remote", "add", "origin", "https://github.com/example/larder.git"], { cwd: repo });
writeFileSync(join(repo, "factory.config.json"), "{}\n");

// A server already on a port would answer instead of the demo's, so stop before anything starts.
for (const port of [API_PORT, WEB_PORT]) {
  const busy = await fetch(`http://localhost:${port}/`).then(() => true, () => false);
  if (busy) throw new Error(`Port ${port} is in use; stop what runs there first.`);
}

const browser = await chromium.launch();
const servers: ChildProcess[] = [];
try {
  await drawPictures(await browser.newPage());
  await seed();
  const env = { FACTORY_REPO: repo, FACTORY_HOME: home, API_PORT: String(API_PORT) };
  servers.push(start(["pnpm", "exec", "tsx", "server/index.ts"], env));
  execFileSync("pnpm", ["build"], { stdio: "ignore" });
  servers.push(start(["pnpm", "exec", "vite", "preview", "--port", String(WEB_PORT), "--strictPort"], env));
  await waitFor(`http://127.0.0.1:${API_PORT}/api/tasks`);
  await waitFor(`http://localhost:${WEB_PORT}/`);

  mkdirSync(OUT, { recursive: true });
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const tasks = (await (await fetch(`http://127.0.0.1:${API_PORT}/api/tasks`)).json()) as Task[];
  const byKey = (key: string) => tasks.find((t) => t.ticketKey === key)!.id;
  await shoot(p, "/", "tasks", "[data-verify-unit=TaskTable]");
  await shoot(p, `/tasks/${byKey("#41")}`, "task-before-after", "[data-verify-unit=BeforeAfter]", "[data-verify-unit=BeforeAfter]");
  await shoot(p, `/tasks/${byKey("#43")}`, "task-sign-off", ".decision__doc");
  await shoot(p, `/tasks/${byKey("#44")}`, "task-steer", "[data-verify-unit=SteerPanel]", "[data-verify-unit=SteerPanel]");
} finally {
  await browser.close();
  for (const s of servers) {
    try {
      if (s.pid) process.kill(-s.pid, "SIGTERM");
    } catch {
      // It has already stopped; its output is in the log.
    }
  }
  rmSync(root, { recursive: true, force: true });
}
