// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { FactoryDb } from "../server/db";
import type { Task, TaskDetail, TaskSummary } from "../shared/api";
import { EXIT, runCli } from "./factory";

let db: FactoryDb;
let calls: Array<{ url: string; actor: string | null }>;

beforeEach(async () => {
  db = await FactoryDb.open(":memory:");
  calls = [];
});
afterEach(() => db.close());

async function cli(argv: string[], env: Record<string, string> = {}) {
  const app = createApp(db, { policy: { alwaysHuman: [{ pattern: "factory.config.json", reason: "policy" }], maxChangedFiles: 20, maxChangedLines: 400 } });
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    fetch: async (url, init) => {
      calls.push({ url, actor: new Headers(init?.headers).get("x-factory-actor") });
      return app.request(url, init);
    },
    env,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const json = async <T>(argv: string[], env?: Record<string, string>) => {
  const r = await cli([...argv, "--json"], env);
  return { ...r, data: JSON.parse(r.out) as T };
};

describe("factory CLI", () => {
  it("adds a task and lists it, as JSON", async () => {
    const add = await json<Task>(["add", "--title", "Build login", "--ticket", "#4", "--phase", "implementing=claude-sonnet-5-5"]);
    expect(add.code).toBe(EXIT.ok);
    expect(add.data).toMatchObject({ title: "Build login", status: "backlog", ticketKey: "#4", phaseModels: { implementing: "claude-sonnet-5-5" } });

    const list = await json<TaskSummary[]>(["list"]);
    expect(list.data.map((t) => t.id)).toEqual([add.data.id]);
  });

  it("prints a readable table without --json", async () => {
    await db.createTask({ title: "Readable", description: "" });
    const r = await cli(["list"]);
    expect(r.out).toMatch(/^ID\s+STATUS\s+TRIES\s+COST\s+TICKET\s+TITLE/);
    expect(r.out).toContain("Readable");
  });

  it("filters to tasks waiting for a decision", async () => {
    await db.createTask({ title: "busy", description: "" }, "implementing");
    const waiting = await db.createTask({ title: "stuck", description: "" }, "escalated");
    const r = await json<TaskSummary[]>(["list", "--waiting"]);
    expect(r.data.map((t) => t.id)).toEqual([waiting.id]);
  });

  it("reports status counts", async () => {
    await db.createTask({ title: "a", description: "" });
    await db.createTask({ title: "b", description: "" }, "escalated");
    const r = await json<{ ok: boolean; tasks: number; waiting: number }>(["status"]);
    expect(r.data).toMatchObject({ ok: true, tasks: 2, waiting: 1, byStatus: { backlog: 1, escalated: 1 } });
  });

  it("approves an escalated task and records the agent as the actor", async () => {
    const task = await db.createTask({ title: "x", description: "" }, "escalated");
    const r = await json<{ task: Task }>(["approve", task.id, "--comment", "env was down, retry"], { FACTORY_ACTOR: "agent:conductor" });
    expect(r.code).toBe(EXIT.ok);
    expect(r.data.task.status).toBe("backlog");
    expect(calls.every((c) => c.actor === "agent:conductor")).toBe(true);

    const detail = await json<TaskDetail>(["show", task.id]);
    expect(detail.data.events.at(-1)).toMatchObject({ type: "status_changed", payload: { to: "backlog", by: "agent:conductor" } });
  });

  it("--actor overrides FACTORY_ACTOR", async () => {
    await cli(["list", "--actor", "agent:pm"], { FACTORY_ACTOR: "agent:conductor" });
    expect(calls[0]?.actor).toBe("agent:pm");
  });

  describe("exit codes", () => {
    it("2 for invalid input, before calling the API", async () => {
      expect((await cli(["add"])).code).toBe(EXIT.invalid);
      expect((await cli(["add", "--title", "x", "--bogus-level", "yolo"])).code).toBe(EXIT.invalid);
      expect((await cli(["add", "--title", "x", "--phase", "cooking=claude-opus-5-5"])).code).toBe(EXIT.invalid);
      expect((await cli(["add", "--title", "x", "--phase", "implementing"])).code).toBe(EXIT.invalid);
      expect((await cli(["show"])).code).toBe(EXIT.invalid);
      expect((await cli(["frobnicate"])).code).toBe(EXIT.invalid);
      expect((await cli(["list", "--bogus"])).code).toBe(EXIT.invalid);
      expect((await cli(["list", "--actor", "root"])).code).toBe(EXIT.invalid);
      expect(calls).toEqual([]);
    });

    it("2 when the API rejects the input", async () => {
      const r = await json<{ error: string }>(["add", "--title", "x".repeat(201)]);
      expect(r.code).toBe(EXIT.invalid);
      expect(calls).toHaveLength(1);
      expect(r.data.error).toMatch(/200/);
    });

    it("3 for an unknown task", async () => {
      expect((await cli(["show", "nope"])).code).toBe(EXIT.notFound);
    });

    it("4 for a decision the current stage does not allow, and nothing changes", async () => {
      const task = await db.createTask({ title: "x", description: "" }, "implementing");
      const r = await json<{ error: string }>(["approve", task.id]);
      expect(r.code).toBe(EXIT.conflict);
      expect(r.data.error).toMatch(/Can't approve/);
      expect((await db.getTask(task.id))?.status).toBe("implementing");
    });

    it("4 for a second task on the same ticket", async () => {
      expect((await cli(["add", "--title", "a", "--ticket", "#9"])).code).toBe(EXIT.ok);
      const again = await json<{ error: string }>(["add", "--title", "b", "--ticket", "#9"]);
      expect(again.code).toBe(EXIT.conflict);
      expect(again.data.error).toMatch(/#9 already has task/);
    });

    it("1 when the server runs no orchestrator", async () => {
      const task = await db.createTask({ title: "x", description: "" });
      expect((await cli(["start"])).code).toBe(EXIT.failed);
      expect((await cli(["step", task.id])).code).toBe(EXIT.failed);
    });

    it("1 when the API is unreachable", async () => {
      const r = await runCli(["list", "--json"], {
        fetch: () => Promise.reject(new Error("ECONNREFUSED")),
        env: {},
        out: (t) => expect(JSON.parse(t).error).toMatch(/Could not reach the factory API at http:\/\/127.0.0.1:8787/),
        err: () => {},
      });
      expect(r).toBe(EXIT.failed);
    });
  });

  it("shows and changes a task's model per phase, recording the agent", async () => {
    const task = await db.createTask({ title: "x", description: "" });
    const shown = await json<{ plan: Record<string, string> }>(["models", task.id]);
    expect(shown.data.plan).toMatchObject({ scoping: "claude-fable-5-2", design: "claude-fable-5-2", reviewing: "claude-fable-5-2", decider: "claude-fable-5-2", implementing: "claude-opus-5-5" });

    const agent = { FACTORY_ACTOR: "agent:conductor" };
    const changed = await json<{ overrides: Record<string, string>; plan: Record<string, string> }>(["models", task.id, "--phase", "implementing=claude-sonnet-5-5"], agent);
    expect(changed.data.overrides).toEqual({ implementing: "claude-sonnet-5-5" });
    expect(changed.data.plan).toMatchObject({ scoping: "claude-fable-5-2", implementing: "claude-sonnet-5-5" });
    expect((await cli(["models", task.id])).out).toContain("(task override)");
    expect((await cli(["models", task.id, "--clear", "implementing"])).out).not.toContain("override");

    const detail = await json<TaskDetail>(["show", task.id]);
    expect(detail.data.events.find((e) => e.type === "models_changed")).toMatchObject({ payload: { by: "agent:conductor" } });
  });

  it("shows and changes the factory defaults", async () => {
    const shown = await json<{ phaseModels: Record<string, string> }>(["defaults"]);
    expect(shown.data.phaseModels).toMatchObject({ scoping: "claude-fable-5-2", test_writing: "claude-opus-5-5" });
    const changed = await json<{ phaseModels: Record<string, string> }>(["defaults", "--phase", "pr=claude-sonnet-5-5"]);
    expect(changed.data.phaseModels).toMatchObject({ pr: "claude-sonnet-5-5", scoping: "claude-fable-5-2" });
    expect((await json<{ phaseModels: Record<string, string> }>(["defaults"])).data.phaseModels.pr).toBe("claude-sonnet-5-5");
  });

  it("adds a task from a ticket alone, waiting for others", async () => {
    await cli(["add", "--ticket", "#5"]);
    const r = await json<Task>(["add", "--ticket", "#6", "--after", "#5"]);
    expect(r.data).toMatchObject({ title: "#6", ticketKey: "#6", ready: false });
    expect((await cli(["add", "--title", "x", "--after", "#99"])).code).toBe(EXIT.invalid);
  });

  it("loads a filed plan in dependency order, and is safe to run twice", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const file = join(mkdtempSync(join(tmpdir(), "plan-")), "p.tickets.json");
    writeFileSync(file, JSON.stringify({ tickets: [
      { key: "CP-02", title: "b", issue: 5, blockedBy: ["CP-01"] },
      { key: "CP-01", title: "a", issue: 4, blockedBy: [] },
      { key: "CP-03", title: "c", issue: 6, blockedBy: ["CP-01", "CP-02"] },
    ] }));
    const first = await json<Array<{ key: string; status: string }>>(["load-plan", file]);
    expect(first.data.map((c) => [c.key, c.status])).toEqual([["CP-01", "created"], ["CP-02", "created"], ["CP-03", "created"]]);
    const tasks = await json<TaskSummary[]>(["list"]);
    const byTicket = new Map(tasks.data.map((t) => [t.ticketKey, t]));
    expect(byTicket.get("#6")!.blockedBy.sort()).toEqual([byTicket.get("#4")!.id, byTicket.get("#5")!.id].sort());
    const again = await json<Array<{ status: string }>>(["load-plan", file]);
    expect(again.data.every((c) => c.status === "exists")).toBe(true);
  });

  it("limits agents: one retry per escalation reason, two change requests per task", async () => {
    const agent = { FACTORY_ACTOR: "agent:conductor" };
    const task = await db.createTask({ title: "x", description: "" }, "escalated");
    await db.updateTask(task.id, { context: { escalation: "The local app did not start", escalatedFrom: "browser_check" } });
    expect((await cli(["approve", task.id, "--comment", "env blip"], agent)).code).toBe(EXIT.ok);
    await db.moveTask(task.id, "browser_check", "escalated");
    await db.updateTask(task.id, { context: { escalation: "The local app did not start" } });
    const again = await json<{ error: string }>(["approve", task.id, "--comment", "again"], agent);
    expect(again.code).toBe(EXIT.refused);
    expect(again.data.error).toMatch(/already retried this escalation once/);
    // A person can still retry, and a different reason gets its own retry.
    await db.updateTask(task.id, { context: { escalation: "The gate failed 3 times" } });
    expect((await cli(["approve", task.id, "--comment", "new reason"], agent)).code).toBe(EXIT.ok);

    const other = await db.createTask({ title: "y", description: "" }, "escalated");
    await db.updateTask(other.id, { context: { escalatedFrom: "implementing" } });
    for (let i = 0; i < 2; i++) {
      expect((await cli(["changes", other.id, "--comment", `fix ${i}`], agent)).code).toBe(EXIT.ok);
      await db.moveTask(other.id, "implementing", "escalated");
    }
    expect((await cli(["changes", other.id, "--comment", "third"], agent)).code).toBe(EXIT.refused);
    expect((await cli(["changes", other.id, "--comment", "a person"])).code).toBe(EXIT.ok);
  });

  it("halts: anyone may, only a person resumes; status shows it", async () => {
    const agent = { FACTORY_ACTOR: "agent:conductor" };
    expect((await cli(["halt"], agent)).code).toBe(EXIT.invalid);
    expect((await cli(["halt", "--reason", "three escalations in a row"], agent)).code).toBe(EXIT.ok);
    expect((await cli(["status"])).out).toMatch(/HALTED by agent:conductor: three escalations in a row/);
    expect((await cli(["resume"], agent)).code).toBe(EXIT.refused);
    expect((await cli(["resume"])).code).toBe(EXIT.ok);
    expect(await db.getHalt()).toBeNull();
    expect((await json<Array<{ message: string }>>(["notifications"])).data[0]!.message).toMatch(/Factory halted by agent:conductor/);
  });

  it("adds a task with its own sign-off gates", async () => {
    const add = await json<Task>(["add", "--ticket", "#9", "--gate", "scoping", "--gate", "design"]);
    expect(add.data.context.gates).toEqual(["scoping", "design"]);
    expect((await cli(["add", "--ticket", "#10", "--gate", "pr"])).code).toBe(EXIT.invalid);
  });

  it("steers, pauses and unpauses a task", async () => {
    const task = await db.createTask({ title: "x", description: "" }, "implementing");
    const steer = await json<{ task: Task; restarted: boolean }>(["steer", task.id, "--message", "Use the card", "--restart"]);
    expect(steer.code).toBe(EXIT.ok);
    expect(steer.data).toMatchObject({ restarted: false, task: { context: { steering: [{ note: "Use the card", by: "human" }] } } });
    expect((await cli(["steer", task.id])).code).toBe(EXIT.invalid);
    expect((await json<Task>(["pause", task.id])).data.context.paused).toBe(true);
    expect((await json<Task>(["unpause", task.id])).data.context.paused).toBeUndefined();
  });

  it("notifies a person about a task", async () => {
    const task = await db.createTask({ title: "x", description: "" });
    expect((await cli(["notify", "--task", task.id, "--message", "Touches payments: please decide"], { FACTORY_ACTOR: "agent:conductor" })).code).toBe(EXIT.ok);
    expect((await cli(["notify", "--task", "nope", "--message", "m"])).code).toBe(EXIT.notFound);
    const list = await json<Array<{ taskId: string; by: string; message: string }>>(["notifications"]);
    expect(list.data[0]).toMatchObject({ taskId: task.id, by: "agent:conductor", message: "Touches payments: please decide" });
  });

  it("follows the event feed with a cursor", async () => {
    await cli(["add", "--ticket", "#5"]);
    const first = await json<{ events: Array<{ id: number; type: string; ticketKey: string; status: string }>; cursor: number }>(["events"]);
    expect(first.data.events.map((e) => [e.type, e.ticketKey, e.status])).toEqual([["task_created", "#5", "backlog"]]);
    expect((await json<{ events: unknown[]; cursor: number }>(["events", "--since", String(first.data.cursor)])).data).toEqual({ events: [], cursor: first.data.cursor });
    await cli(["add", "--ticket", "#6"]);
    const next = await json<{ events: Array<{ ticketKey: string }> }>(["events", "--since", String(first.data.cursor), "--types", "task_created"]);
    expect(next.data.events.map((e) => e.ticketKey)).toEqual(["#6"]);
    expect((await cli(["events", "--since", "abc"])).code).toBe(EXIT.invalid);
  });

  it("status reports the loop and spend", async () => {
    const r = await json<{ loop: { available: boolean }; costUsd: number }>(["status"]);
    expect(r.data).toMatchObject({ loop: { available: false, running: false }, costUsd: 0 });
  });

  it("requires a comment to request changes", async () => {
    const task = await db.createTask({ title: "x", description: "" }, "escalated");
    expect((await cli(["changes", task.id])).code).toBe(EXIT.invalid);
    expect((await cli(["changes", task.id, "--comment", "split it"])).code).toBe(EXIT.ok);
  });

  it("prints help, and JSON help for agents", async () => {
    expect((await cli(["help"])).out).toContain("factory add (--title <title> | --ticket <#n>)");
    const r = await json<{ commands: Array<{ usage: string }> }>(["help"]);
    expect(r.data.commands.map((c) => c.usage.split(" ")[0])).toContain("approve");
    expect((await cli([])).code).toBe(EXIT.invalid);
  });
});
