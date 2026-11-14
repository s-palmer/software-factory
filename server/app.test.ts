// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EnvStatus, Feedback, Learning, Task, TaskDetail, TaskSummary } from "../shared/api";
import { createApp } from "./app";
import { FactoryDb } from "./db";
import { LocalEnv } from "./environment";

let db: FactoryDb;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  db = await FactoryDb.open(":memory:");
  app = createApp(db);
});
afterEach(() => db.close());

const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function escalatedTask(from: "design" | "browser_check" = "browser_check"): Promise<Task> {
  const task = await db.createTask({ title: "Ship it", description: "" }, "escalated");
  await db.updateTask(task.id, { attempts: 3, context: { escalation: "The browser check failed 3 times", escalatedFrom: from, deciderUsed: ["implementing"] } });
  return (await db.getTask(task.id))!;
}

describe("tasks", () => {
  it("creates a task in backlog and lists it", async () => {
    const res = await post("/api/tasks", { title: "  Build login  " });
    expect(res.status).toBe(201);
    const task = (await res.json()) as Task;
    expect(task).toMatchObject({ title: "Build login", status: "backlog", description: "", screenshotCount: 0 });

    const list = (await (await app.request("/api/tasks")).json()) as TaskSummary[];
    expect(list.map((t) => t.id)).toEqual([task.id]);
  });

  it("rejects a blank title", async () => {
    const res = await post("/api/tasks", { title: "   " });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Title is required (or give a ticket)" });
  });

  it("rejects a non-JSON body", async () => {
    const res = await app.request("/api/tasks", { method: "POST", body: "nope" });
    expect(res.status).toBe(400);
  });

  it("404s for an unknown task", async () => {
    expect((await app.request("/api/tasks/nope")).status).toBe(404);
  });

  it("returns detail with artifacts, history and screenshot count", async () => {
    const task = await escalatedTask();
    const add = await post(`/api/tasks/${task.id}/artifacts`, { kind: "screenshot", path: "screenshots/a b.png", label: "AC-1 after" });
    expect(add.status).toBe(201);

    const detail = (await (await app.request(`/api/tasks/${task.id}`)).json()) as TaskDetail;
    expect(detail.task.screenshotCount).toBe(1);
    expect(detail.artifacts[0]).toMatchObject({ label: "AC-1 after", url: "/artifacts/screenshots/a%20b.png" });
    expect(detail.events.map((e) => e.type)).toEqual(["task_created", "artifact_added"]);
  });

  it("refuses artifact paths that escape the artifact root", async () => {
    const task = await escalatedTask();
    for (const path of ["../secrets.png", "/etc/passwd", "screenshots/../../x.png"]) {
      expect((await post(`/api/tasks/${task.id}/artifacts`, { kind: "screenshot", path })).status).toBe(400);
    }
  });
});

describe("feedback", () => {
  it("approve retries the stage that escalated, with a fresh retry budget and decider", async () => {
    const task = await escalatedTask();
    const res = await post(`/api/tasks/${task.id}/feedback`, { decision: "approve" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { task: Task; feedback: Feedback };
    expect(body.task).toMatchObject({ status: "browser_check", attempts: 0 });
    expect(body.task.context.deciderUsed).toEqual([]);
    expect(body.task.context.escalation).toBeUndefined();
    expect(body.feedback).toMatchObject({ decision: "approve", comment: "", artifactId: null });

    const detail = (await (await app.request(`/api/tasks/${task.id}`)).json()) as TaskDetail;
    expect(detail.events.at(-1)).toMatchObject({ type: "status_changed", payload: { from: "escalated", to: "browser_check", by: "human" } });
  });

  it("request_changes sends it to implement when code exists, with the comment as feedback, and saves no learning", async () => {
    const task = await escalatedTask();
    await post(`/api/tasks/${task.id}/artifacts`, { kind: "screenshot", path: "screenshots/x.png" });
    const artifactId = ((await (await app.request(`/api/tasks/${task.id}`)).json()) as TaskDetail).artifacts[0]!.id;

    const res = await post(`/api/tasks/${task.id}/feedback`, { decision: "request_changes", comment: "Button overlaps the title", artifactId });
    expect(res.status).toBe(201);
    const moved = ((await res.json()) as { task: Task }).task;
    expect(moved.status).toBe("implementing");
    expect(moved.context.feedback).toEqual(["A person asked for changes: Button overlaps the title"]);
    expect((await (await app.request("/api/learnings")).json()) as Learning[]).toEqual([]);
  });

  it("request_changes before code exists goes back to the stage that escalated", async () => {
    const task = await escalatedTask("design");
    const res = await post(`/api/tasks/${task.id}/feedback`, { decision: "request_changes", comment: "Use the existing card" });
    expect(((await res.json()) as { task: Task }).task.status).toBe("design");
  });

  it("requires a comment when requesting changes", async () => {
    const task = await escalatedTask();
    const res = await post(`/api/tasks/${task.id}/feedback`, { decision: "request_changes", comment: "  " });
    expect(res.status).toBe(400);
    expect(((await db.getTask(task.id)) as Task).status).toBe("escalated");
  });

  it("refuses to approve a task that isn't waiting on a human (409) and changes nothing", async () => {
    const task = await db.createTask({ title: "Busy", description: "" }, "implementing");
    const res = await post(`/api/tasks/${task.id}/feedback`, { decision: "approve" });
    expect(res.status).toBe(409);
    const detail = (await (await app.request(`/api/tasks/${task.id}`)).json()) as TaskDetail;
    expect(detail.feedback).toEqual([]);
    expect(detail.task.status).toBe("implementing");
  });

  it("allows comments in any status without changing it", async () => {
    const task = await db.createTask({ title: "Busy", description: "" }, "implementing");
    const res = await post(`/api/tasks/${task.id}/feedback`, { decision: "comment", comment: "FYI: use the design tokens" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { task: Task }).task.status).toBe("implementing");
  });

  it("rejects feedback pointing at another task's screenshot", async () => {
    const a = await escalatedTask();
    const b = await escalatedTask();
    const other = await db.addArtifact(b.id, { kind: "screenshot", path: "screenshots/b.png", label: "" });
    const res = await post(`/api/tasks/${a.id}/feedback`, { decision: "request_changes", comment: "x", artifactId: other.id });
    expect(res.status).toBe(400);
  });
});

describe("timestamps", () => {
  it("are second-precision ISO strings everywhere", async () => {
    const task = await escalatedTask();
    await post(`/api/tasks/${task.id}/artifacts`, { kind: "screenshot", path: "screenshots/x.png" });
    await post(`/api/tasks/${task.id}/feedback`, { decision: "comment", comment: "hi" });
    const d = (await (await app.request(`/api/tasks/${task.id}`)).json()) as TaskDetail;
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
    for (const ts of [d.task.createdAt, d.task.updatedAt, d.artifacts[0]!.createdAt, d.feedback[0]!.createdAt, ...d.events.map((e) => e.ts)]) {
      expect(ts).toMatch(iso);
    }
  });
});

describe("models", () => {
  it("default per phase: Fable judges, Opus builds; a task can override phases at creation", async () => {
    const defaults = (await (await app.request("/api/models")).json()) as { phaseModels: Record<string, string> };
    expect(defaults.phaseModels).toEqual({
      planning: "claude-fable-5-2", scoping: "claude-fable-5-2", design: "claude-fable-5-2", reviewing: "claude-fable-5-2", decider: "claude-fable-5-2", retro: "claude-fable-5-2", conductor: "claude-fable-5-2",
      test_writing: "claude-opus-5-5", implementing: "claude-opus-5-5", browser_check: "claude-opus-5-5", pr: "claude-opus-5-5",
    });
    const b = (await (await post("/api/tasks", { title: "B", phaseModels: { implementing: "claude-sonnet-5-5" } })).json()) as Task;
    expect(b.phaseModels).toEqual({ implementing: "claude-sonnet-5-5" });
    expect((await post("/api/tasks", { title: "C", phaseModels: { implementing: "gpt-5" } })).status).toBe(400);
    expect((await post("/api/tasks", { title: "C", phaseModels: { cooking: "claude-opus-5-5" } })).status).toBe(400);
  });

  it("factory defaults can be changed and are saved", async () => {
    const put = (body: unknown) => app.request("/api/models", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const res = (await (await put({ phaseModels: { browser_check: "claude-sonnet-5-5" } })).json()) as { phaseModels: Record<string, string> };
    expect(res.phaseModels).toMatchObject({ browser_check: "claude-sonnet-5-5", scoping: "claude-fable-5-2" });
    expect((await db.getDefaultModels()).browser_check).toBe("claude-sonnet-5-5");
    expect((await put({ phaseModels: {} })).status).toBe(400);
    expect((await put({ phaseModels: { browser_check: "nope" } })).status).toBe(400);
  });

  it("task overrides can be set and cleared, and the change is recorded with its actor", async () => {
    const task = await db.createTask({ title: "x", description: "", phaseModels: { reviewing: "claude-opus-5-5" } });
    const put = (body: unknown) =>
      app.request(`/api/tasks/${task.id}/models`, { method: "PUT", headers: { "content-type": "application/json", "x-factory-actor": "agent:conductor" }, body: JSON.stringify(body) });
    const changed = (await (await put({ phaseModels: { design: "claude-opus-5-5" }, clear: ["reviewing"] })).json()) as Task;
    expect(changed.phaseModels).toEqual({ design: "claude-opus-5-5" });
    expect((await put({ clear: ["cooking"] })).status).toBe(400);
    expect((await put({})).status).toBe(400);
    const detail = (await (await app.request(`/api/tasks/${task.id}`)).json()) as TaskDetail;
    expect(detail.events.at(-1)).toMatchObject({ type: "models_changed", payload: { to: { design: "claude-opus-5-5" }, by: "agent:conductor" } });
  });

  it("404s for an unknown task", async () => {
    const res = await app.request("/api/tasks/nope/models", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ clear: ["design"] }) });
    expect(res.status).toBe(404);
  });
});

describe("tickets", () => {
  it("allow one task per ticket", async () => {
    const first = (await (await post("/api/tasks", { title: "#3", ticketKey: "#3" })).json()) as Task;
    const res = await post("/api/tasks", { title: "again", ticketKey: "#3" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ taskId: first.id });
  });
});

describe("ticket keys", () => {
  it("normalises GitHub issue numbers and refuses other keys", async () => {
    const task = (await (await post("/api/tasks", { ticketKey: "12" })).json()) as Task;
    expect(task).toMatchObject({ ticketKey: "#12", title: "#12" });
    expect((await post("/api/tasks", { ticketKey: "PROJ-1" })).status).toBe(400);
  });

  it("checks keys against an MCP tracker's pattern, and turns off the GitHub-only PM run", async () => {
    app = createApp(db, { tracker: { type: "mcp", name: "jira", label: "Jira", server: {}, tools: "*", keyPattern: "^[A-Z]+-\\d+$", instructions: "x" } });
    expect(await (await post("/api/tasks", { ticketKey: "PROJ-1" })).json()).toMatchObject({ ticketKey: "PROJ-1" });
    expect(await (await post("/api/tasks", { ticketKey: "#3" })).json()).toMatchObject({ error: expect.stringContaining("not a Jira ticket key") });
    const plan = await post("/api/plans", { source: "#3" });
    expect(plan.status).toBe(409);
    expect(await (await app.request("/api/tracker")).json()).toEqual({ type: "mcp", label: "Jira", keyPattern: "^[A-Z]+-\\d+$" });
  });
});

describe("artifacts", () => {
  it("lets a person remove a screenshot, with its file", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-artifacts-"));
    app = createApp(db, { artifactRoot: root });
    const task = await db.createTask({ title: "x", description: "" });
    mkdirSync(join(root, "tasks/t/r"), { recursive: true });
    writeFileSync(join(root, "tasks/t/r/a.png"), "png");
    const artifact = await db.addArtifact(task.id, { kind: "screenshot", path: "tasks/t/r/a.png", label: "AFTER: PASS: A" });
    const res = await app.request(`/api/artifacts/${artifact.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(existsSync(join(root, "tasks/t/r/a.png"))).toBe(false);
    expect((await db.getTaskDetail(task.id))!.artifacts).toEqual([]);
    expect((await app.request(`/api/artifacts/${artifact.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("never deletes a file outside the artifact root", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-artifacts-"));
    const outside = join(mkdtempSync(join(tmpdir(), "factory-outside-")), "keep.png");
    writeFileSync(outside, "png");
    app = createApp(db, { artifactRoot: root });
    const task = await db.createTask({ title: "x", description: "" });
    // The API refuses such a path; this checks the delete does not trust the stored one either.
    const evil = await db.addArtifact(task.id, { kind: "screenshot", path: `../${outside.split("/").slice(-2).join("/")}`, label: "x" });
    await app.request(`/api/artifacts/${evil.id}`, { method: "DELETE" });
    expect(existsSync(outside)).toBe(true);
  });
});

describe("pull request links", () => {
  it("gives a task with a PR its web address", async () => {
    app = createApp(db, { repoWebUrl: "https://github.com/o/r" });
    const task = await db.createTask({ title: "x", description: "" });
    expect(((await (await app.request(`/api/tasks/${task.id}`)).json()) as TaskDetail).task.prUrl).toBeNull();
    await db.updateTask(task.id, { prNumber: 42 });
    expect(((await (await app.request(`/api/tasks/${task.id}`)).json()) as TaskDetail).task.prUrl).toBe("https://github.com/o/r/pull/42");
  });
});

describe("learnings", () => {
  it("lets a person edit and approve a learning, and apply it; an agent may do neither", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "factory-learnings-")), "learnings.md");
    app = createApp(db, { learningsFile: file });
    const task = await db.createTask({ title: "x", description: "" });
    const [l] = await db.addLearnings(task.id, [{ kind: "factory", summary: "Read the plan first.", target: null, evidence: [] }]);
    const patch = (body: unknown, actor = "human") =>
      app.request(`/api/learnings/${l!.id}`, { method: "PATCH", headers: { "content-type": "application/json", "x-factory-actor": actor }, body: JSON.stringify(body) });
    expect((await patch({ status: "approved" }, "agent:pm")).status).toBe(403);
    expect((await patch({})).status).toBe(400);
    expect(await (await patch({ summary: "Read the task list first.", kind: "codebase", status: "approved" })).json()).toMatchObject({
      summary: "Read the task list first.",
      kind: "codebase",
      target: "CLAUDE.md",
      status: "approved",
    });
    expect((await app.request("/api/learnings/apply", { method: "POST", headers: { "x-factory-actor": "agent:pm" } })).status).toBe(403);
    const applied = (await (await app.request("/api/learnings/apply", { method: "POST" })).json()) as { tasks: unknown[] };
    expect(applied.tasks).toHaveLength(1);
    expect((await patch({ summary: "too late" })).status).toBe(409);
  });
});

describe("local environment", () => {
  function fakeEnv(up = false) {
    const started: string[] = [];
    const stopped: number[] = [];
    return {
      started,
      stopped,
      controller: {
        start: (dir: string) => (started.push(dir), 777),
        isUp: async () => up,
        isRunning: () => true,
        stop: async (pid: number) => void stopped.push(pid),
        logTail: () => "listening on 5173",
        portHolders: async () => [{ port: 5173, pid: 99, command: "node" }],
      },
    };
  }
  const envConfig = { command: "pnpm dev", url: "http://localhost:5173", healthUrls: ["http://localhost:5173"], checkout: "/code/app", artifactRoot: "/tmp/factory-env-test" };
  const human = (path: string) => app.request(path, { method: "POST" });

  it("shows which task holds it and who waits", async () => {
    const env = fakeEnv(true);
    app = createApp(db, { env: new LocalEnv(db, env.controller, envConfig) });
    const holder = await db.createTask({ title: "Paginate", description: "", ticketKey: "#4" }, "browser_check");
    const waiter = await db.createTask({ title: "Sort", description: "" }, "browser_check");
    await db.updateTask(waiter.id, { context: { envWait: "Another task is using the local app." } });
    await db.acquireLease("env", holder.id, null);
    await db.updateLeasePid("env", 4242, "/logs/env.log");
    const s = (await (await app.request("/api/env")).json()) as EnvStatus;
    expect(s).toMatchObject({ configured: true, up: true, external: false, log: "listening on 5173" });
    expect(s.lease).toMatchObject({ holder: "task", taskId: holder.id, ticketKey: "#4", title: "Paginate", pid: 4242, status: "browser_check" });
    expect(s.waiting).toEqual([{ taskId: waiter.id, ticketKey: null, title: "Sort", reason: "Another task is using the local app." }]);
    expect((await human("/api/env/stop")).status).toBe(409);
    expect(env.stopped).toEqual([]);
  });

  it("names the outside process when the factory did not start the app", async () => {
    app = createApp(db, { env: new LocalEnv(db, fakeEnv(true).controller, envConfig) });
    const s = (await (await app.request("/api/env")).json()) as EnvStatus;
    expect(s).toMatchObject({ external: true, lease: null, portHolders: [{ port: 5173, pid: 99, command: "node" }] });
    expect(await (await human("/api/env/start")).json()).toMatchObject({ ok: false, message: expect.stringContaining("outside the factory") });
  });

  it("lets a person start and stop a copy from the checkout, but not an agent", async () => {
    const env = fakeEnv(false);
    app = createApp(db, { env: new LocalEnv(db, env.controller, envConfig) });
    const asAgent = await app.request("/api/env/start", { method: "POST", headers: { "x-factory-actor": "agent:pm" } });
    expect(asAgent.status).toBe(403);
    expect((await human("/api/env/start")).status).toBe(200);
    expect(env.started).toEqual(["/code/app"]);
    expect(await db.getLease("env")).toMatchObject({ taskId: null, pid: 777 });
    expect((await human("/api/env/start")).status).toBe(409);
    expect((await human("/api/env/stop")).status).toBe(200);
    expect(env.stopped).toEqual([777]);
    expect(await db.getLease("env")).toBeNull();
  });
});

describe("dependencies", () => {
  it("take blockers by id or ticket key at creation, and report them with readiness", async () => {
    const a = (await (await post("/api/tasks", { title: "A", ticketKey: "#5" })).json()) as Task;
    const b = (await (await post("/api/tasks", { title: "B", blockedBy: ["#5"] })).json()) as Task;
    expect(b).toMatchObject({ blockedBy: [a.id], ready: false });
    expect(a).toMatchObject({ blockedBy: [], ready: true });
    const res = await post("/api/tasks", { title: "C", blockedBy: ["#404"] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown blocker #404" });
    expect(((await (await app.request("/api/tasks")).json()) as TaskSummary[]).map((t) => t.title)).not.toContain("C");
  });
});

describe("orchestrator routes", () => {
  it("answer 503 when the server has no orchestrator", async () => {
    expect(await (await app.request("/api/orchestrator")).json()).toEqual({ available: false, running: false });
    const put = await app.request("/api/orchestrator", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ running: true }) });
    expect(put.status).toBe(503);
    const task = await db.createTask({ title: "x", description: "" });
    expect((await post(`/api/tasks/${task.id}/step`, {})).status).toBe(503);
  });
});

