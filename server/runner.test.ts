// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunDetail, TaskDetail, TestRun } from "../shared/api";
import { createApp } from "./app";
import { FactoryDb } from "./db";
import { RunBusyError, TestRunner } from "./runner";

const FAKE = ["node", "e2e/fixtures/fake-playwright.mjs"];

let db: FactoryDb;
let root: string;
beforeEach(async () => {
  db = await FactoryDb.open(":memory:");
  root = mkdtempSync(join(tmpdir(), "factory-runs-"));
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const runner = (env: Record<string, string> = {}) => new TestRunner(db, { artifactRoot: root, command: FAKE, env: { FAKE_DELAY_MS: "50", ...env } });

describe("TestRunner", () => {
  it("records a passing run with parsed results, media URLs, log and report", async () => {
    const r = runner();
    const { run, done } = await r.start(null);
    expect(run.status).toBe("running");
    expect(r.runningId).toBe(run.id);

    const finished = await done;
    expect(finished).toMatchObject({ status: "passed", exitCode: 0, summary: { passed: 2, failed: 0, durationMs: 1235 } });
    expect(finished.reportUrl).toBe(`/artifacts/runs/${run.id}/playwright-report/index.html`);
    expect(r.runningId).toBeNull();

    const results = await db.getRunResults(run.id);
    expect(results.map((t) => t.title)).toEqual(["create a task from the dashboard", "review screenshots"]);
    expect(results[0]!.attachments[0]).toMatchObject({ kind: "screenshot", url: `/artifacts/runs/${run.id}/test-results/a/test-finished-1.png` });
    expect(r.readLog(run.id)).toContain("2 passed");
  });

  it("marks a run with failing tests as failed and strips colour codes from errors", async () => {
    const { done } = await runner({ FAKE_OUTCOME: "fail" }).start(null);
    const finished = await done;
    expect(finished).toMatchObject({ status: "failed", exitCode: 1, summary: { failed: 1 } });
    const failed = (await db.getRunResults(finished.id)).find((t) => t.status === "failed");
    expect(failed?.error).toBe('Expected: "implementing"\nReceived: "backlog"');
  });

  it("marks a run that produced no report as an error, keeping the log", async () => {
    const r = runner({ FAKE_OUTCOME: "crash" });
    const { done } = await r.start(null);
    const finished = await done;
    expect(finished).toMatchObject({ status: "error", exitCode: 2, summary: null });
    expect(r.readLog(finished.id)).toContain("browser failed to launch");
  });

  it("reports an error when the command can't be started at all", async () => {
    const r = new TestRunner(db, { artifactRoot: root, command: ["definitely-not-a-real-binary"] });
    const { done } = await r.start(null);
    expect((await done).status).toBe("error");
  });

  it("allows only one run at a time, even for simultaneous starts", async () => {
    const r = runner();
    const attempts = await Promise.allSettled([r.start(null), r.start(null)]);
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((a) => a.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(RunBusyError);
    await (attempts.find((a) => a.status === "fulfilled") as PromiseFulfilledResult<{ done: Promise<TestRun> }>).value.done;
    await expect(r.start(null).then((s) => s.done)).resolves.toMatchObject({ status: "passed" });
  });

  it("attaches the run's screenshots to its task", async () => {
    const task = await db.createTask({ title: "UI change", description: "" }, "browser_check");
    const { done } = await runner().start(task.id);
    const finished = await done;
    const detail = (await db.getTaskDetail(task.id)) as TaskDetail;
    const short = finished.id.slice(0, 8);
    expect(detail.artifacts.map((a) => a.label).sort()).toEqual([`run ${short} · create a task from the dashboard`, `run ${short} · dashboard--home`]);
    expect(detail.events.map((e) => e.type)).toContain("test_run_finished");
  });
});

describe("runs API", () => {
  it("starts a run (202), refuses a second (409), and serves detail", async () => {
    const r = runner();
    const app = createApp(db, { runner: r });
    const post = (body: unknown) => app.request("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const first = await post({});
    expect(first.status).toBe(202);
    const run = (await first.json()) as TestRun;
    const second = await post({});
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ runningId: run.id });

    while (r.runningId) await new Promise((res) => setTimeout(res, 20));
    const detail = (await (await app.request(`/api/runs/${run.id}`)).json()) as RunDetail;
    expect(detail.run.status).toBe("passed");
    expect(detail.results).toHaveLength(2);
    expect(detail.log).toContain("Running 2 tests");

    const list = (await (await app.request("/api/runs")).json()) as TestRun[];
    expect(list.map((x) => x.id)).toEqual([run.id]);
  });

  it("404s for an unknown task or run, 503 without a runner", async () => {
    const app = createApp(db, { runner: runner() });
    const res = await app.request("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: "nope" }) });
    expect(res.status).toBe(404);
    expect((await app.request("/api/runs/nope")).status).toBe(404);
    expect((await createApp(db).request("/api/runs", { method: "POST" })).status).toBe(503);
  });
});
