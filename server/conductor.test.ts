// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaudeCall } from "./claude";
import { Conductor, CONDUCTOR_ACTOR, CONDUCTOR_RUNS } from "./conductor";
import { FactoryDb } from "./db";
import type { Effects } from "./orchestrator";

let db: FactoryDb;
let dir: string;
let calls: Array<{ call: ClaudeCall; env?: Record<string, string> }>;

const effects = {
  async claude(call: ClaudeCall, opts: { runDir: string; env?: Record<string, string> }) {
    calls.push({ call, ...(opts.env ? { env: opts.env } : {}) });
    return { ok: true, subtype: "success", costUsd: 0.3, turns: 5, sessionId: "s", output: { summary: "Retried one task.", actions: [{ command: "factory approve t1", why: "env was down" }], handedToPerson: [] }, text: "", logPath: join(opts.runDir, "stream.jsonl") };
  },
} as unknown as Effects;

beforeEach(async () => {
  db = await FactoryDb.open(":memory:");
  dir = mkdtempSync(join(tmpdir(), "factory-conductor-"));
  calls = [];
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const conductor = () => new Conductor(db, effects, { cwd: dir, artifactRoot: dir, apiUrl: "http://127.0.0.1:8787" });

describe("the conductor", () => {
  it("runs on Fable with only the factory CLI and read tools, as agent:conductor, and records its run", async () => {
    const id = await conductor().run();
    const { call, env } = calls[0]!;
    expect(call.model).toBe("claude-fable-5-2");
    expect(call.allowedTools).toEqual(["Bash(factory:*)", "Read", "Grep", "Glob"]);
    expect(call.disallowedTools).toEqual(expect.arrayContaining(["Write", "Edit", "Bash(git:*)", "Bash(gh:*)", "Task", "AskUserQuestion"]));
    expect(call.prompt).toContain("factory list --waiting --json");
    expect(env).toMatchObject({ FACTORY_ACTOR: CONDUCTOR_ACTOR, FACTORY_URL: "http://127.0.0.1:8787" });
    expect(env?.PATH).toMatch(/\/bin:/);
    const run = await db.getAgentRun(id!);
    expect(run).toMatchObject({ taskId: CONDUCTOR_RUNS, kind: "conductor", status: "passed", summary: "Retried one task." });
  });

  it("does not run while the factory is halted", async () => {
    await db.setHalt({ reason: "costs climbing", by: "human" });
    expect(await conductor().run()).toBeNull();
    expect(calls).toEqual([]);
  });
});
