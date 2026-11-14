import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runClaude } from "./claude";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("runClaude", () => {
  it("stops the process when the signal aborts, and reports the run as stopped", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "factory-claude-"));
    dirs.push(runDir);
    const controller = new AbortController();
    const started = Date.now();
    const run = runClaude(
      { prompt: "x", allowedTools: [], disallowedTools: [], mcpServers: {}, outputSchema: {}, maxBudgetUsd: 1, model: "m" },
      { cwd: runDir, runDir, command: [process.execPath, "-e", "setTimeout(() => {}, 30000)", "--"], signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 100);
    const result = await run;
    expect(result).toMatchObject({ ok: false, subtype: "stopped" });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
