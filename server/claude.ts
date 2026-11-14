/**
 * Runs one agent phase as one headless Claude Code process.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type ClaudeCall = {
  prompt: string;
  allowedTools: string[];
  disallowedTools: string[];
  mcpServers: Record<string, unknown>;
  outputSchema: object;
  maxBudgetUsd: number;
  settings?: object | undefined;
  model?: string | undefined;
  /** Folders outside the working directory the run may read, such as the factory's skills. */
  addDirs?: string[] | undefined;
};

export type ClaudeFiles = { mcpConfig: string; systemPrompt: string; settings?: string | undefined };

export type ParsedResult = {
  ok: boolean;
  subtype: string;
  costUsd: number;
  turns: number;
  sessionId: string | null;
  output: unknown;
  text: string;
};

export type ClaudeResult = ParsedResult & { logPath: string };

export const HeadlessPrompt = fileURLToPath(new URL("../prompts/headless.md", import.meta.url));

/** Approved learnings from earlier tasks. Every run reads them after the fixed rules. */
export const LearningsFile = fileURLToPath(new URL("../prompts/learnings.md", import.meta.url));

const readIfExists = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");

export function systemPromptText(rules: string, learnings: string): string {
  if (!learnings.trim()) return rules;
  return `${rules}\n\n## Learnings from earlier tasks\n\n${learnings}`;
}

export function buildClaudeArgs(call: ClaudeCall, files: ClaudeFiles): string[] {
  const args = [
    "-p",
    call.prompt,
    // Without these two flags a run loads every MCP server and plugin of the user,
    // which made one turn cost more than ten turns of a lean run.
    "--strict-mcp-config",
    "--mcp-config",
    files.mcpConfig,
    "--setting-sources",
    "project",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    call.allowedTools.join(","),
    "--disallowedTools",
    call.disallowedTools.join(","),
    "--append-system-prompt-file",
    files.systemPrompt,
    "--json-schema",
    JSON.stringify(call.outputSchema),
    "--max-budget-usd",
    String(call.maxBudgetUsd),
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  if (files.settings) args.push("--settings", files.settings);
  if (call.model) args.push("--model", call.model);
  for (const dir of call.addDirs ?? []) args.push("--add-dir", dir);
  return args;
}

/** The last `result` event of a stream-json log, or null if the run never produced one. */
export function parseStream(text: string): ParsedResult | null {
  let result: Record<string, unknown> | null = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "result") result = event;
    } catch {
      // A partial last line from a killed process is expected; skip it.
    }
  }
  if (!result) return null;
  return {
    ok: result.is_error === false && result.subtype === "success",
    subtype: String(result.subtype),
    costUsd: Number(result.total_cost_usd ?? 0),
    turns: Number(result.num_turns ?? 0),
    sessionId: typeof result.session_id === "string" ? result.session_id : null,
    output: result.structured_output ?? null,
    text: String(result.result ?? ""),
  };
}

export type RunOptions = {
  cwd: string;
  runDir: string;
  /** The agent runtime command; tests pass a fake that writes a real stream log. */
  command?: string[] | undefined;
  env?: Record<string, string> | undefined;
  /** The approved learnings for this repository. Default: the factory's own prompts/learnings.md. */
  learningsFile?: string | undefined;
};

export function runClaude(call: ClaudeCall, options: RunOptions): Promise<ClaudeResult> {
  mkdirSync(options.runDir, { recursive: true });
  const mcpConfig = join(options.runDir, "mcp.json");
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: call.mcpServers }));
  let settings: string | undefined;
  if (call.settings) {
    settings = join(options.runDir, "settings.json");
    writeFileSync(settings, JSON.stringify(call.settings));
  }
  const logPath = join(options.runDir, "stream.jsonl");
  const stderrPath = join(options.runDir, "stderr.log");
  const systemPrompt = join(options.runDir, "system-prompt.md");
  writeFileSync(
    systemPrompt,
    systemPromptText(readFileSync(HeadlessPrompt, "utf8"), readIfExists(options.learningsFile ?? LearningsFile)),
  );
  const [bin = "claude", ...prefix] = options.command ?? ["claude"];
  const args = [...prefix, ...buildClaudeArgs(call, { mcpConfig, settings, systemPrompt })];

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: ClaudeResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const read = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");
    const crash = (message: string): void =>
      settle({ ok: false, subtype: "crash", costUsd: 0, turns: 0, sessionId: null, output: null, text: message, logPath });

    const log = createWriteStream(logPath);
    const errLog = createWriteStream(stderrPath);
    // A test runner can set NODE_OPTIONS (a module loader) that breaks child processes.
    const { NODE_OPTIONS: _drop, ...parentEnv } = process.env;
    const child = spawn(bin, args, { cwd: options.cwd, env: { ...parentEnv, ...options.env }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(log);
    child.stderr.pipe(errLog);

    // A failed spawn can emit "close" before "error", so both paths settle once and read the logs only if they exist.
    child.on("error", (error) => crash(`could not start ${bin}: ${error.message}`));
    child.on("close", (code) => {
      let finished = 0;
      const done = (): void => {
        if (++finished < 2) return;
        const parsed = parseStream(read(logPath));
        if (parsed) return settle({ ...parsed, logPath });
        crash(`claude stopped with exit code ${code} and no result.\n${read(stderrPath).slice(-2000)}`);
      };
      log.end(done);
      errLog.end(done);
    });
  });
}
