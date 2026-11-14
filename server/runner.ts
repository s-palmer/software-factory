/**
 * Runs the Playwright suite as a child process on behalf of the dashboard (and, later, the orchestrator).
 * One run at a time: the suite starts its own servers on fixed ports.
 *
 * Each run writes everything under <artifactRoot>/runs/<runId>/: output.log, e2e-report.json,
 * the HTML report (with trace viewer), videos, traces and screenshots.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, closeSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TestResult, TestRun } from "../shared/api";
import type { FactoryDb } from "./db";
import { parseReport, type PwReport } from "./report";

export interface RunnerOptions {
  /** Directory runs are written under (served at /artifacts). */
  artifactRoot: string;
  /** Command + args that run the suite. Default: Playwright via pnpm. */
  command?: string[];
  /** Working directory for the command (the project root). */
  cwd?: string;
  /** Extra environment for the child. */
  env?: Record<string, string>;
}

export class RunBusyError extends Error {
  constructor(readonly runningId: string) {
    super("A test run is already in progress");
  }
}

const LOG_TAIL_BYTES = 64 * 1024;

export class TestRunner {
  private current: { id: string; done: Promise<TestRun> } | null = null;
  private readonly root: string;

  constructor(
    private readonly db: FactoryDb,
    private readonly opts: RunnerOptions,
  ) {
    this.root = resolve(opts.artifactRoot);
  }

  get runningId(): string | null {
    return this.current?.id ?? null;
  }

  runDir(id: string): string {
    return join(this.root, "runs", id);
  }

  /** Start a run. Resolves once it has started; `done` resolves when it finishes. */
  async start(taskId: string | null): Promise<{ run: TestRun; done: Promise<TestRun> }> {
    if (this.current) throw new RunBusyError(this.current.id);
    // Claim the slot before any await so two concurrent starts can't both get through.
    const slot: { id: string; done: Promise<TestRun> } = { id: "", done: Promise.resolve(null as unknown as TestRun) };
    this.current = slot;
    try {
      const run = await this.db.createRun(taskId);
      slot.id = run.id;
      slot.done = this.execute(run).finally(() => {
        if (this.current === slot) this.current = null;
      });
      return { run, done: slot.done };
    } catch (err) {
      this.current = null;
      throw err;
    }
  }

  /** Last ~64KB of the run's output. */
  readLog(id: string): string {
    const file = join(this.runDir(id), "output.log");
    if (!existsSync(file)) return "";
    const size = statSync(file).size;
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buf, 0, buf.length, start);
    } finally {
      closeSync(fd);
    }
    return (start > 0 ? "…\n" : "") + buf.toString("utf8");
  }

  private async execute(run: TestRun): Promise<TestRun> {
    const dir = this.runDir(run.id);
    mkdirSync(dir, { recursive: true });
    const log = createWriteStream(join(dir, "output.log"));
    const [cmd, ...args] = this.opts.command ?? ["pnpm", "exec", "playwright", "test"];

    const exitCode = await new Promise<number | null>((resolveExit) => {
      const child = spawn(cmd!, args, {
        cwd: this.opts.cwd ?? process.cwd(),
        // Videos and traces for every test, so a remote viewer can watch each session.
        env: { ...process.env, ...this.opts.env, ARTIFACT_DIR: dir, PW_VIDEO: "on", PW_TRACE: "on", FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      child.on("error", (err) => {
        log.write(`\n[factory] failed to start ${cmd}: ${err.message}\n`);
        resolveExit(null);
      });
      child.on("close", (code) => resolveExit(code));
    });
    log.write(`\n[factory] exited with code ${exitCode}\n`);
    await new Promise<void>((r) => log.end(r));

    const reportFile = join(dir, "e2e-report.json");
    let results: TestResult[] = [];
    let summary = null;
    if (existsSync(reportFile)) {
      try {
        ({ results, summary } = parseReport(JSON.parse(readFileSync(reportFile, "utf8")) as PwReport, this.root));
      } catch {
        // Unparseable report → treated like a missing one below.
      }
    }
    const status = !summary ? "error" : exitCode === 0 && summary.failed === 0 ? "passed" : "failed";
    const htmlReport = join(dir, "playwright-report", "index.html");
    const reportPath = existsSync(htmlReport) ? `runs/${run.id}/playwright-report/index.html` : null;

    if (run.taskId) await this.attachScreenshots(run, results);
    return this.db.finishRun(run.id, { status, exitCode, summary, results, reportPath });
  }

  /** Give the task the run's screenshots, so they show up in its gallery for review. */
  private async attachScreenshots(run: TestRun, results: TestResult[]): Promise<void> {
    const short = run.id.slice(0, 8);
    const seen = new Set<string>();
    const shotsDir = join(this.runDir(run.id), "screenshots");
    const explicit = existsSync(shotsDir) ? readdirSync(shotsDir).filter((f) => f.endsWith(".png")).sort() : [];
    for (const file of explicit) {
      const path = `runs/${run.id}/screenshots/${file}`;
      seen.add(path);
      await this.db.addArtifact(run.taskId!, { kind: "screenshot", path, label: `run ${short} · ${file.replace(/\.png$/, "")}` });
    }
    for (const r of results) {
      for (const a of r.attachments) {
        if (a.kind !== "screenshot" || seen.has(a.path)) continue;
        seen.add(a.path);
        await this.db.addArtifact(run.taskId!, { kind: "screenshot", path: a.path, label: `run ${short} · ${r.title}` });
      }
    }
  }
}
