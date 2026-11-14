/**
 * The conductor: a scheduled headless agent that runs the programme through the
 * `factory` CLI only. It handles escalations and plans; the API, not its prompt, enforces what it may do.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { modelFor } from "../shared/models";
import type { ClaudeCall } from "./claude";
import type { FactoryDb } from "./db";
import type { Effects } from "./orchestrator";
import { BUDGETS, denyTools } from "./phases";

export const CONDUCTOR_ACTOR = "agent:conductor";
/** agent_runs rows need a task id; the conductor's runs use this one. */
export const CONDUCTOR_RUNS = "conductor";

const PROMPT = fileURLToPath(new URL("../prompts/conductor.md", import.meta.url));
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");

const str = { type: "string" } as const;
export const CONDUCTOR_SCHEMA = {
  type: "object",
  properties: {
    summary: str,
    actions: { type: "array", items: { type: "object", properties: { command: str, why: str }, required: ["command", "why"], additionalProperties: false } },
    handedToPerson: { type: "array", items: str },
  },
  required: ["summary", "actions", "handedToPerson"],
  additionalProperties: false,
} as const;

export function conductorCall(model: string): ClaudeCall {
  return {
    prompt: readFileSync(PROMPT, "utf8"),
    // Only the factory CLI and read tools; every write goes through the API, which checks the actor.
    allowedTools: ["Bash(factory:*)", "Read", "Grep", "Glob"],
    disallowedTools: [...denyTools(), "Write", "Edit", "Bash(git:*)", "Bash(gh:*)"],
    mcpServers: {},
    outputSchema: CONDUCTOR_SCHEMA,
    maxBudgetUsd: BUDGETS.conductor,
    model,
  };
}

export class Conductor {
  private running = false;

  constructor(
    private readonly db: FactoryDb,
    private readonly effects: Effects,
    private readonly config: { cwd: string; artifactRoot: string; apiUrl: string },
  ) {}

  /** One conductor run, unless one is already running or the factory is halted. Returns the run id. */
  async run(): Promise<string | null> {
    if (this.running || (await this.db.getHalt())) return null;
    this.running = true;
    try {
      const model = modelFor("conductor", await this.db.getDefaultModels());
      const run = await this.db.startAgentRun(CONDUCTOR_RUNS, "backlog", "conductor", model);
      const runDir = join(this.config.artifactRoot, "conductor", run.id);
      mkdirSync(runDir, { recursive: true });
      try {
        const result = await this.effects.claude(conductorCall(model), {
          cwd: this.config.cwd,
          runDir,
          env: { PATH: `${BIN}:${process.env.PATH ?? ""}`, FACTORY_ACTOR: CONDUCTOR_ACTOR, FACTORY_URL: this.config.apiUrl },
        });
        await this.db.finishAgentRun(run.id, {
          status: result.ok ? "passed" : "failed",
          costUsd: result.costUsd,
          turns: result.turns,
          output: result.output,
          summary: result.ok ? String((result.output as { summary?: string } | null)?.summary ?? "").slice(0, 1000) : `${result.subtype}: ${result.text.slice(0, 500)}`,
          logPath: result.logPath,
        });
      } catch (error) {
        await this.db.finishAgentRun(run.id, { status: "error", summary: (error as Error).message.slice(0, 500) });
      }
      return run.id;
    } finally {
      this.running = false;
    }
  }
}
