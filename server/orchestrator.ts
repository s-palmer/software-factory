/**
 * The factory orchestrator: plain code that takes one step of one task at a time, runs the
 * stage's agent, checks the result itself and moves the task. No human gates: questions go to the decider, and
 * anything it cannot settle, any exhausted retry limit and any high-risk change escalates.
 *
 * Every side effect goes through `Effects`, so tests drive the whole lifecycle with fakes.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import type { Task, TaskContext, TaskDetail } from "../shared/api";
import { afterFailure, afterSuccess, FACTORY_STAGES, type Gate, type TaskStatus } from "../shared/lifecycle";
import { modelFor, type Phase } from "../shared/models";
import { classifyRisk, type FileChange, type RiskPolicy } from "../shared/risk";
import type { ClaudeCall, ClaudeResult } from "./claude";
import type { FactoryDb } from "./db";
import { runIsolation, type IsolationConfig } from "./isolation";
import { retroCall, type RetroOutput } from "./retro";
import { beforeCaptureCall, deciderCall, lockedFilesSettings, phaseCall, type AgentStage, type BrowserStep, type PhaseContext, type PhaseTracker, type ToolRules, type VerifyContext } from "./phases";

export interface GateStep {
  name: string;
  ok: boolean;
  output: string;
}
export interface GateResult {
  ok: boolean;
  steps: GateStep[];
}

export interface EnvController {
  /** Start the local app from `worktree` as its own process group; returns the pid. */
  start(worktree: string, logPath: string): number;
  /** Every health URL answers. */
  isUp(): Promise<boolean>;
  isRunning(pid: number): boolean;
  /** Stop the whole process group. */
  stop(pid: number): Promise<void>;
  logTail(logPath: string): string;
  /** Processes listening on the health URLs' ports. */
  portHolders?(): Promise<Array<{ port: number; pid: number; command: string }>>;
}

/** One fixture checked in the browser. `screenshot` is a file name in the run's output folder. */
export type VerifyRun = { unit: string; fixture: string; verdict: "PASS" | "FAIL" | "BLOCKED" | "SKIP"; failures: string[]; screenshot: string | null };

/** The unit ids of the verify specs among `files` (a spec is `<dir>/specs/<Unit>.verify.ts`). */
export function verifyUnits(files: string[], dir: string): string[] {
  const re = new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/specs/([^/]+)\\.verify\\.tsx?$`);
  return [...new Set(files.flatMap((f) => re.exec(f)?.[1] ?? []))];
}

/** What the factory reads from an open pull request. */
export type PrStatus = {
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  headSha: string;
  checks: "pass" | "fail" | "pending";
  failures: string[];
  /** The branch conflicts with the base branch. */
  conflicting: boolean;
  /** Reviews asking for changes, with when they were submitted. */
  changesRequested: Array<{ at: string; by: string; body: string }>;
};

/** Thrown when a person stops a run, so the step ends without an escalation. */
class RunStopped extends Error {}

export interface Effects {
  claude(call: ClaudeCall, options: { cwd: string; runDir: string; env?: Record<string, string>; signal?: AbortSignal }): Promise<ClaudeResult>;
  createWorktree(task: Task): Promise<{ branch: string; worktree: string }>;
  /**
   * Runs `fn` on a clean checkout of the merge base, with dependencies installed. The checkout is shared, so it is
   * held until `fn` finishes: keep `fn` to the work that needs it.
   */
  withBaseCheckout<T>(worktree: string, fn: (dir: string) => Promise<T>): Promise<T>;
  /** Files git does not track yet, relative to the worktree. */
  untrackedFiles(worktree: string): Promise<string[]>;
  /** A GitHub issue's text, for the prompts. */
  fetchIssue(cwd: string, key: string): Promise<NonNullable<TaskContext["ticket"]>>;
  fileExists(worktree: string, path: string): boolean;
  /** Changes since the merge base with the base branch. */
  diff(worktree: string): Promise<FileChange[]>;
  /** Lint, type check and tests, compared with the merge base. */
  gate(worktree: string, changes: FileChange[]): Promise<GateResult>;
  /** Type check new test files, allowing "not yet implemented" errors. */
  typecheckTests(worktree: string, files: string[]): Promise<GateResult>;
  /**
   * Open each fixture of these units on the harness page of the running app, read the verdict and save a
   * screenshot to `outDir`. `missing`: units the harness does not list.
   */
  verifyInBrowser(opts: { baseUrl: string; entry: string; units: string[]; outDir: string }): Promise<{ results: VerifyRun[]; missing: string[] }>;
  runTests(worktree: string, files: string[]): Promise<{ ok: boolean; output: string }>;
  /** `force`: the branch was moved onto the base, so it replaces the remote with --force-with-lease. */
  commitAndPush(worktree: string, branch: string, message: string, force?: boolean): Promise<void>;
  /**
   * Move the task's own change onto the latest base branch as one patch. Conflicts are left as markers in the listed files.
   */
  syncWithBase(worktree: string): Promise<{ upToDate: boolean; conflicts: string[] }>;
  createPr(worktree: string, branch: string, title: string, body: string): Promise<number>;
  updatePrBody(worktree: string, pr: number, body: string): Promise<void>;
  prStatus(worktree: string, pr: number): Promise<PrStatus>;
  /** Mark the PR ready for review (CI green), or back to draft while the factory works on it. */
  setReady(worktree: string, pr: number, ready: boolean): Promise<void>;
  env: EnvController;
}

export interface OrchestratorConfig {
  artifactRoot: string;
  maxAttempts: number;
  policy: RiskPolicy;
  /** Path of server/guard.mjs, the locked-file hook. */
  guardScript: string;
  envStartTimeoutMs: number;
  browserBaseUrl: string;
  /** The browser tool server for a run, given the folder its screenshots go to. */
  browserMcp?: ((outputDir: string) => Record<string, unknown>) | undefined;
  /** The project's commands, for the agents' tool rules. */
  tools?: ToolRules | undefined;
  /** The phase skills folder. */
  skillsDir?: string | undefined;
  /** Skill files per stage that replace the defaults. */
  stageSkills?: Partial<Record<string, string[]>> | undefined;
  /** A ticket system behind MCP; without it, tickets are GitHub issues the factory reads. */
  tracker?: PhaseTracker | undefined;
  /** Without it, runs are not sandboxed (tests with fakes). */
  isolation?: IsolationConfig | undefined;
  /** Runtime verification of UI units, when the project has it. */
  verify?: VerifyContext | undefined;
  /** GitHub logins whose issues and comments count as trusted. */
  trustedAuthors?: string[] | undefined;
  /** Stages after which a task stops for a person's approval, unless the task sets its own. */
  gates?: Gate[] | undefined;
  /** How many tasks the loop works on at once. Default 1. */
  maxParallel?: number | undefined;
  /** The branch PRs target, named in the review and PR prompts (default "main"). */
  baseBranch?: string;
  tickMs: number;
  now?: () => Date;
}

const ENV_LEASE = "env";

/** Where `createWorktree` puts a task's worktree (its project folder may be below it). */
export const worktreeRoot = (home: string, taskId: string) => join(home, "worktrees", taskId);

const AGENT_STAGES: ReadonlySet<TaskStatus> = new Set(["scoping", "design", "test_writing", "implementing", "reviewing", "pr"]);

export class Orchestrator {
  private readonly busy = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Tasks with a step in progress, started by the loop. */
  private readonly inflight = new Set<string>();

  constructor(
    private readonly db: FactoryDb,
    private readonly effects: Effects,
    private readonly config: OrchestratorConfig,
  ) {}

  /* ------------------------------ The loop ------------------------------ */

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.config.tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The ready task in a factory stage that waited longest, so tasks interleave. */
  /** Stops the agent run in progress on a task. The task stays in its stage and runs it again on its next step. */
  interrupt(taskId: string): boolean {
    const run = this.liveRuns.get(taskId);
    if (!run) return false;
    run.abort();
    return true;
  }

  /** The agent run in progress per task, so a person can stop it. */
  private readonly liveRuns = new Map<string, AbortController>();

  async nextTask(): Promise<string | null> {
    const queue = await this.db.taskQueue([...FACTORY_STAGES]);
    return queue.find((id) => !this.busy.has(id)) ?? null;
  }

  /**
   * Starts a step for each free slot (up to `maxParallel` tasks at once), each on the ready task that waited longest,
   * and waits for the ones it started. Returns false when nothing was ready. Overlapping ticks only fill free slots.
   * Shared resources are leased or locked where they are used: the local app (the env lease), the merge-base checkout
   * and writes to the shared repository (locks in the effects).
   */
  async tick(): Promise<boolean> {
    // The kill switch: a halted factory takes no steps.
    if (await this.db.getHalt()) return false;
    // A retro runs beside the loop, one at a time, so it never holds up a task.
    if (!this.retroRunning) void this.retroNext();
    const started: Array<Promise<void>> = [];
    while (this.inflight.size < (this.config.maxParallel ?? 1)) {
      const id = await this.nextTask();
      if (!id || this.inflight.has(id)) break;
      this.inflight.add(id);
      started.push(this.step(id).finally(() => this.inflight.delete(id)));
    }
    await Promise.all(started);
    return started.length > 0;
  }

  /** How many tasks have a step in progress, out of how many may. */
  get load(): { running: number; max: number } {
    return { running: this.inflight.size, max: this.config.maxParallel ?? 1 };
  }

  async step(taskId: string): Promise<void> {
    if (this.busy.has(taskId)) return;
    this.busy.add(taskId);
    try {
      const task = await this.db.getTask(taskId);
      if (!task || !FACTORY_STAGES.has(task.status) || task.context.paused) return;
      if (task.status === "backlog") return await this.setUp(task);
      if (task.status === "browser_check") return await this.browserCheck(task);
      if (task.status === "awaiting_merge") return await this.watchPr(task);
      if (AGENT_STAGES.has(task.status)) return await this.agentStage(task, task.status as AgentStage);
    } catch (error) {
      // A person stopped the run: the task stays where it is and runs the stage again, with their note.
      if (error instanceof RunStopped) return;
      const task = await this.db.getTask(taskId);
      if (task) await this.escalate(task, `The factory failed: ${(error as Error).message}`);
    } finally {
      this.busy.delete(taskId);
    }
  }

  /* ------------------------------ Moves ------------------------------ */

  private now(): Date {
    return this.config.now?.() ?? new Date();
  }

  private retroRunning = false;

  /** What a retro covers: the task's end state. A task that escalates again for another reason gets another retro. */
  private retroKey(task: Task): string | null {
    if (task.status === "done") return "done";
    if (task.status === "escalated") return `escalated:${task.context.escalatedFrom ?? ""}:${task.context.escalation ?? ""}`.slice(0, 300);
    return null;
  }

  /** Runs the retro of one ended task that has not had one for its end state. Returns whether it ran one. */
  async retroNext(): Promise<boolean> {
    if (this.retroRunning) return false;
    this.retroRunning = true;
    try {
      for (const summary of await this.db.listTasks()) {
        if (summary.status !== "done" && summary.status !== "escalated") continue;
        const detail = await this.db.getTaskDetail(summary.id);
        if (!detail?.task.worktree) continue;
        const key = this.retroKey(detail.task);
        if (!key || detail.events.some((e) => e.type === "retro_done" && e.payload.key === key)) continue;
        await this.retro(detail, key);
        return true;
      }
      return false;
    } catch (error) {
      console.error("[factory] retro failed:", error);
      return false;
    } finally {
      this.retroRunning = false;
    }
  }

  private async retro(detail: TaskDetail, key: string): Promise<void> {
    // Recorded first, so a retro that fails is not tried again and again.
    await this.db.recordEvent(detail.task.id, "retro_done", { key });
    const result = await this.runAgent(detail.task, "retro", { phase: "retro", kind: "retro", build: (ctx) => retroCall(detail, ctx) });
    if (!result.ok) return;
    const output = result.output as RetroOutput | null;
    const learnings = (output?.learnings ?? []).slice(0, 3).flatMap((l) => {
      const summary = String(l.summary ?? "").trim();
      if (!summary) return [];
      const kind = l.kind === "codebase" ? ("codebase" as const) : ("factory" as const);
      const target = kind === "codebase" ? String(l.target ?? "").trim() || "CLAUDE.md" : null;
      return [{ kind, summary, target, evidence: (l.evidence ?? []).map(String).slice(0, 5) }];
    });
    await this.db.addLearnings(detail.task.id, learnings);
  }

  /** After scoping or design: on to the next stage, or, when the task has that gate, stop for a person's approval. */
  private async moveOrStop(task: Task, stage: Gate): Promise<void> {
    const gates = task.context.gates ?? this.config.gates ?? [];
    if (!gates.includes(stage)) return this.move(task, afterSuccess(stage));
    await this.db.updateTask(task.id, { context: { gateStage: stage } });
    await this.move(task, "awaiting_approval");
  }

  private async move(task: Task, to: TaskStatus): Promise<void> {
    await this.db.moveTask(task.id, task.status, to, "factory");
  }

  private async escalate(task: Task, reason: string): Promise<void> {
    const current = await this.db.getTask(task.id);
    if (!current || current.status === "escalated") return;
    await this.db.updateTask(task.id, { context: { escalation: reason, escalatedFrom: current.status } });
    await this.move(current, "escalated");
  }

  /** Count an attempt and move by the failure rule, with the feedback the next attempt reads. */
  private async fail(task: Task, stage: TaskStatus, reason: string, feedback: string[]): Promise<void> {
    const attempts = task.attempts + 1;
    const next = afterFailure(stage, attempts, this.config.maxAttempts);
    await this.db.updateTask(task.id, {
      attempts,
      context: { feedback, ...(next === "escalated" ? { escalation: `${reason} (attempt ${attempts} of ${this.config.maxAttempts})`, escalatedFrom: stage } : {}) },
    });
    await this.move(task, next);
  }

  /** Stay in the stage but go to the back of the queue, so a waiting task does not starve the others. */
  private async wait(task: Task, context: Partial<TaskContext> = {}): Promise<void> {
    await this.db.updateTask(task.id, { context });
  }

  /* ------------------------------ Stages ------------------------------ */

  private async setUp(task: Task): Promise<void> {
    const run = await this.db.startAgentRun(task.id, "backlog", "worktree");
    try {
      const { branch, worktree } = await this.effects.createWorktree(task);
      // A GitHub issue is read here, once, and goes into every prompt: agents get no GitHub access.
      const ticket = !this.config.tracker && task.ticketKey ? await this.effects.fetchIssue(worktree, task.ticketKey) : undefined;
      await this.db.updateTask(task.id, { branch, worktree, ...(ticket ? { context: { ticket } } : {}) });
      await this.db.finishAgentRun(run.id, { status: "passed", summary: `${branch} at ${worktree}` });
    } catch (error) {
      await this.db.finishAgentRun(run.id, { status: "error", summary: (error as Error).message.slice(0, 500) });
      throw error;
    }
    await this.move(task, afterSuccess("backlog"));
  }

  private runDir(task: Task, runId: string): string {
    return join(this.config.artifactRoot, "tasks", task.id, runId);
  }

  private async runAgent(
    task: Task,
    stage: AgentStage | "retro",
    opts: { phase?: Phase; kind?: string; browserUrl?: string; build?: (ctx: PhaseContext) => ClaudeCall } = {},
  ): Promise<ClaudeResult & { runId: string; screenshotDir: string }> {
    const phase = opts.phase ?? stage;
    const model = modelFor(phase, await this.db.getDefaultModels(), task.phaseModels);
    // A retro is recorded under the stage the task ended in, with kind "retro".
    const run = await this.db.startAgentRun(task.id, stage === "retro" ? task.status : stage, opts.kind ?? "agent", model);
    const runDir = this.runDir(task, run.id);
    mkdirSync(runDir, { recursive: true });
    const screenshotDir = join(runDir, "screenshots");
    if (stage === "browser_check") mkdirSync(screenshotDir, { recursive: true });
    const context = task.context;
    let settings: object | undefined;
    if (stage === "implementing" && !opts.build) {
      const list = join(runDir, "locked.json");
      writeFileSync(list, JSON.stringify(context.lockedFiles ?? []));
      settings = lockedFilesSettings(list, this.config.guardScript);
    }
    const ctx: PhaseContext = {
      model,
      feedback: context.feedback ?? [],
      lockedFiles: context.lockedFiles ?? [],
      browserUrl: opts.browserUrl ?? this.config.browserBaseUrl,
      browserPlan: (context.browserPlan ?? []) as BrowserStep[],
      browserMcp: stage === "browser_check" ? this.config.browserMcp?.(screenshotDir) : undefined,
      screenshotDir: stage === "browser_check" ? screenshotDir : undefined,
      baseBranch: this.config.baseBranch,
      tools: this.config.tools,
      skillsDir: this.config.skillsDir,
      stageSkills: this.config.stageSkills,
      tracker: this.config.tracker,
      verify: this.config.verify,
      trustedAuthors: this.config.trustedAuthors,
      steering: (context.steering ?? []).map((s) => s.note),
      isolation: this.config.isolation && task.worktree ? runIsolation(this.config.isolation, worktreeRoot(this.config.isolation.home, task.id)) : undefined,
      settings,
    };
    let result: ClaudeResult;
    // A retro runs beside the task's own steps, so only stage runs can be stopped.
    const controller = stage === "retro" ? null : new AbortController();
    if (controller) this.liveRuns.set(task.id, controller);
    try {
      result = await this.effects.claude(opts.build ? opts.build(ctx) : phaseCall(stage as AgentStage, task, ctx), {
        cwd: task.worktree ?? ".",
        runDir,
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (error) {
      await this.db.finishAgentRun(run.id, { status: "error", summary: (error as Error).message.slice(0, 500) });
      throw error;
    } finally {
      if (controller && this.liveRuns.get(task.id) === controller) this.liveRuns.delete(task.id);
    }
    if (controller?.signal.aborted) {
      await this.db.finishAgentRun(run.id, { status: "error", costUsd: result.costUsd, summary: "Stopped by a person; the stage runs again", logPath: result.logPath });
      throw new RunStopped();
    }
    await this.db.finishAgentRun(run.id, {
      status: result.ok ? "passed" : "failed",
      costUsd: result.costUsd,
      turns: result.turns,
      sessionId: result.sessionId,
      output: result.output,
      summary: result.ok ? summaryOf(result.output) : `${result.subtype}: ${result.text.slice(0, 500)}`,
      logPath: result.logPath,
    });
    return { ...result, runId: run.id, screenshotDir };
  }

  private async agentStage(task: Task, stage: AgentStage): Promise<void> {
    const result = await this.runAgent(task, stage);
    if (!result.ok) return this.escalate(task, `The ${stage} run stopped: ${result.subtype}. ${result.text.slice(0, 500)}`);
    const output = (result.output ?? {}) as Record<string, unknown>;
    const questions = strings(output.questions);

    if (questions.length > 0) {
      const answered = await this.decide(task, stage, questions, String(output.summary ?? ""));
      if (!answered) {
        await this.db.updateTask(task.id, { context: { questions } });
        return this.escalate(task, `The ${stage} phase has questions the decider could not settle: ${questions.join(" ")}`);
      }
      // Scoping hands the answers to design; any other stage runs again with them.
      if (stage !== "scoping") return;
    }

    switch (stage) {
      case "scoping": {
        // A task made from an issue number alone takes the issue's title. A typed title stays.
        const title = String(output.title ?? task.context.ticket?.title ?? "").trim();
        await this.db.updateTask(task.id, {
          ...(title && task.title === task.ticketKey ? { title } : {}),
          context: { needsBrowser: Boolean(output.needsBrowser), questions: [], feedback: questions.length ? (await this.db.getTask(task.id))!.context.feedback : [] },
        });
        return this.moveOrStop(task, "scoping");
      }
      case "design":
        await this.db.updateTask(task.id, {
          context: {
            needsBrowser: Boolean(output.needsBrowser),
            browserPath: typeof output.browserPath === "string" ? output.browserPath : "/",
            browserPlan: Array.isArray(output.browserPlan) ? (output.browserPlan as BrowserStep[]) : [],
            feedback: [],
          },
        });
        return this.moveOrStop(task, "design");
      case "test_writing":
        return this.checkTests(task, output);
      case "implementing":
        return this.checkImplementation(task, output);
      case "reviewing": {
        const blocking = strings(output.blocking);
        if (output.verdict !== "approve" || blocking.length > 0) {
          return this.fail(task, "reviewing", `Review found blocking issues: ${blocking.join(" ")}`, blocking.map((b) => `The reviewer found: ${b}`));
        }
        await this.db.updateTask(task.id, { context: { feedback: [] } });
        return this.move(task, afterSuccess("reviewing", { needsBrowser: task.context.needsBrowser ?? true }));
      }
      case "pr":
        return this.publish(task, output);
      case "browser_check":
        throw new Error("browser_check runs through browserCheck");
    }
  }

  /**
   * The decider answers a phase's questions, once per stage. Returns false when a person must
   * decide: the run failed, gave nothing, flagged a question as needing a person, or already ran for this stage.
   */
  private async decide(task: Task, stage: AgentStage, questions: string[], summary: string): Promise<boolean> {
    const used = task.context.deciderUsed ?? [];
    if (used.includes(stage)) return false;
    await this.db.updateTask(task.id, { context: { deciderUsed: [...used, stage] } });
    const result = await this.runAgent(task, stage, {
      phase: "decider",
      kind: "decider",
      build: (ctx) => deciderCall(task, ctx, stage, questions, summary),
    });
    const decisions = ((result.output as { decisions?: unknown } | null)?.decisions ?? []) as Array<{ question: string; answer: string; needsHuman: boolean }>;
    if (!result.ok || decisions.length === 0 || decisions.some((d) => d.needsHuman)) return false;
    await this.db.updateTask(task.id, {
      context: {
        feedback: decisions.map((d) => `${d.question} Decision: ${d.answer}`),
        decisions: [...(task.context.decisions ?? []), ...decisions.map((d) => ({ stage, question: d.question, answer: d.answer }))],
        questions: [],
      },
    });
    await this.db.recordEvent(task.id, "decisions_made", { stage, decisions });
    return true;
  }

  /** The test phase's output is checked by code, not trusted. */
  private async checkTests(task: Task, output: Record<string, unknown>): Promise<void> {
    const worktree = task.worktree!;
    const files = strings(output.testFiles);
    const noTestsReason = String(output.noTestsReason ?? "").trim();
    if (files.length === 0 && noTestsReason) {
      await this.db.updateTask(task.id, { context: { lockedFiles: [], noTestsReason, feedback: [] } });
      return this.move(task, afterSuccess("test_writing"));
    }
    const missing = files.filter((f) => !this.effects.fileExists(worktree, f));
    if (files.length === 0 || missing.length > 0) {
      return this.escalate(task, `The test phase wrote no usable test files. Missing: ${missing.join(", ") || "all"}`);
    }
    // Implement cannot edit locked tests, so type faults in them must be fixed now.
    const types = await this.effects.typecheckTests(worktree, files);
    if (!types.ok) {
      return this.fail(task, "test_writing", "The new tests add type errors", failedSteps(types, "on the new tests"));
    }
    // Back from implement with test fixes: the code exists, so the implement gate runs the tests instead.
    if (task.context.codeExists) {
      await this.db.updateTask(task.id, { context: { lockedFiles: files, codeExists: undefined, feedback: [] } });
      return this.move(task, "implementing");
    }
    const run = await this.db.startAgentRun(task.id, "test_writing", "red-check");
    // A verify spec is not a test file: the matrix test runs every registered spec.
    const verify = this.config.verify;
    const runnable = verify ? [...new Set(files.map((f) => (verifyUnits([f], verify.dir).length || f === `${verify.dir}/specs/index.ts` ? `${verify.dir}/matrix.test.ts` : f)))] : files;
    const tests = await this.effects.runTests(worktree, runnable);
    await this.db.finishAgentRun(run.id, { status: tests.ok ? "failed" : "passed", summary: tests.output.slice(-2000) });
    if (tests.ok) return this.escalate(task, "The new tests pass before the change, so they do not test it.");
    await this.db.updateTask(task.id, { context: { lockedFiles: files, feedback: [] } });
    return this.move(task, afterSuccess("test_writing"));
  }

  private async checkImplementation(task: Task, output: Record<string, unknown>): Promise<void> {
    // A locked test can be wrong in a way no implementation passes; the test phase owns it.
    const testFixes = strings(output.testFixes);
    if (testFixes.length > 0) {
      const attempts = task.attempts + 1;
      if (attempts >= this.config.maxAttempts) return this.escalate(task, `The locked tests still need changes: ${testFixes.join(" ")}`);
      await this.db.updateTask(task.id, {
        attempts,
        context: { codeExists: true, feedback: testFixes.map((f) => `The implement phase found this problem in your tests. Fix the test, not the code: ${f}`) },
      });
      return this.move(task, "test_writing");
    }
    await this.db.updateTask(task.id, { context: { followUps: strings(output.followUps) } });

    const worktree = task.worktree!;
    const changes = await this.effects.diff(worktree);
    const run = await this.db.startAgentRun(task.id, "implementing", "gate");
    let result: GateResult;
    try {
      result = await this.effects.gate(worktree, changes);
    } catch (error) {
      // Close the run, so it does not stay "running" with nothing behind it.
      await this.db.finishAgentRun(run.id, { status: "error", summary: (error as Error).message.slice(0, 500) });
      throw error;
    }
    await this.db.finishAgentRun(run.id, {
      status: result.ok ? "passed" : "failed",
      output: result.steps.map((s) => ({ name: s.name, ok: s.ok })),
      summary: result.steps.map((s) => `${s.ok ? "pass" : "FAIL"} ${s.name}`).join(", "),
    });
    if (!result.ok) {
      return this.fail(task, "implementing", `The gate failed: ${result.steps.filter((s) => !s.ok).map((s) => s.name).join(", ")}`, failedSteps(result));
    }
    const risk = classifyRisk(changes, this.config.policy, { lockedFiles: task.context.lockedFiles ?? [] });
    await this.db.updateTask(task.id, { context: { risk, feedback: [], codeExists: true } });
    return this.move(task, afterSuccess("implementing"));
  }

  /** The browser check under the environment lease. The lease is always released. */
  private async browserCheck(task: Task): Promise<void> {
    if (!(await this.db.acquireLease(ENV_LEASE, task.id, null))) {
      return this.wait(task, { envWait: "Another task is using the local app. The browser check waits for it." });
    }
    let pid: number | null = null;
    try {
      // Never test an app the factory did not start: it may be another worktree's code.
      if (await this.effects.env.isUp()) {
        return await this.wait(task, { envWait: "The local app is already running outside the factory. The browser check waits until it stops." });
      }
      const logPath = join(this.config.artifactRoot, "tasks", task.id, `env-${this.now().getTime()}.log`);
      mkdirSync(join(this.config.artifactRoot, "tasks", task.id), { recursive: true });
      pid = this.effects.env.start(task.worktree!, logPath);
      await this.db.updateLeasePid(ENV_LEASE, pid, logPath);
      const started = pid;
      // Stop waiting as soon as the process exits: its start script may have failed.
      await waitUntil(async () => (await this.effects.env.isUp()) || !this.effects.env.isRunning(started), this.config.envStartTimeoutMs);
      if (!(await this.effects.env.isUp())) {
        return await this.escalate(task, `The local app did not start. End of ${logPath}:\n${this.effects.env.logTail(logPath)}`);
      }
      // The changed UI units first, by code: each fixture on the harness page, with a screenshot.
      if (this.config.verify) {
        const failed = await this.verifyUnitsInBrowser(task, this.config.verify);
        if (failed) return;
      }
      const browserUrl = new URL(task.context.browserPath ?? "/", this.config.browserBaseUrl).toString();
      const result = await this.runAgent(task, "browser_check", { browserUrl });
      // The screenshots are evidence for the reviewer, kept with the task: never in the worktree or the commit.
      await this.collectScreenshots(task, result.screenshotDir, result.output, "AFTER");
      if (!result.ok) return await this.escalate(task, `The browser run stopped: ${result.subtype}. ${result.text.slice(0, 500)}`);
      const output = result.output as { blocked: boolean; summary: string; criteria: Array<{ criterion: string; pass: boolean; untestable?: boolean; evidence: string }> };
      if (output.blocked) return await this.escalate(task, `The browser check was blocked: ${output.summary}`);
      // A criterion the local app cannot show is not a failure; the PR lists it.
      const untested = output.criteria.filter((c) => !c.pass && c.untestable).map((c) => ({ criterion: c.criterion, reason: c.evidence }));
      const failed = output.criteria.filter((c) => !c.pass && !c.untestable);
      await this.db.updateTask(task.id, { context: { untested, envWait: undefined } });
      if (failed.length > 0) {
        return await this.fail(
          task,
          "browser_check",
          `The browser check failed: ${failed.map((c) => c.criterion).join("; ")}`,
          failed.map((c) => `In the browser, "${c.criterion}" failed: ${c.evidence}`),
        );
      }
      await this.db.updateTask(task.id, { context: { feedback: [] } });
      // The same criteria on the merge base, for a before-and-after view. Evidence, not a gate.
      await this.effects.env.stop(pid);
      pid = null;
      await this.captureBefore(task, output.criteria.map((c) => c.criterion), browserUrl);
      return await this.move(task, afterSuccess("browser_check"));
    } finally {
      if (pid !== null) await this.effects.env.stop(pid);
      await this.db.releaseLease(ENV_LEASE);
    }
  }

  /**
   * Starts the app on the merge base and lets a capture-only agent photograph the criteria, then stops the app. The
   * caller holds the env lease. The merge-base checkout is held for the whole capture, so no other task checks out
   * another commit under the running app. Any failure is recorded and skipped: the task moves on without them.
   */
  private async captureBefore(task: Task, criteria: string[], browserUrl: string): Promise<void> {
    if (criteria.length === 0) return;
    try {
      await this.effects.withBaseCheckout(task.worktree!, async (base) => {
        const logPath = join(this.config.artifactRoot, "tasks", task.id, `env-before-${this.now().getTime()}.log`);
        const pid = this.effects.env.start(base, logPath);
        try {
          await this.db.updateLeasePid(ENV_LEASE, pid, logPath);
          await waitUntil(async () => (await this.effects.env.isUp()) || !this.effects.env.isRunning(pid), this.config.envStartTimeoutMs);
          if (!(await this.effects.env.isUp())) {
            await this.db.recordEvent(task.id, "before_capture_skipped", { reason: `The app did not start on the merge base. Log: ${logPath}` });
            return;
          }
          const result = await this.runAgent(task, "browser_check", { kind: "before", browserUrl, build: (ctx) => beforeCaptureCall(task, ctx, criteria) });
          const recorded = await this.collectScreenshots(task, result.screenshotDir, result.output, "BEFORE");
          if (recorded === 0) await this.db.recordEvent(task.id, "before_capture_skipped", { reason: result.ok ? "No screenshots were taken on the merge base" : `The run stopped: ${result.subtype}` });
        } finally {
          await this.effects.env.stop(pid);
        }
      });
    } catch (error) {
      await this.db.recordEvent(task.id, "before_capture_skipped", { reason: (error as Error).message.slice(0, 500) });
    }
  }

  /**
   * Moves the screenshots a browser run reports into its screenshot folder, wherever the browser saved them (the
   * Playwright server can save a relative name in the worktree), and records each one with its criterion:
   * "BEFORE: <criterion>" or "AFTER: PASS|FAIL: <criterion>". Returns how many it recorded.
   */
  private async collectScreenshots(task: Task, dir: string, output: unknown, side: "BEFORE" | "AFTER"): Promise<number> {
    const criteria = ((output as { criteria?: Array<{ criterion: string; pass?: boolean; screenshots?: string[] }> } | null)?.criteria ?? []);
    let recorded = 0;
    for (const c of criteria) {
      for (const name of c.screenshots ?? []) {
        const from = [isAbsolute(name) ? name : join(dir, name), join(task.worktree!, name), join(task.worktree!, basename(name))].find((p) => existsSync(p));
        if (!from) continue;
        mkdirSync(dir, { recursive: true });
        const to = join(dir, basename(name));
        if (from !== to) renameSync(from, to);
        const label = side === "BEFORE" ? `BEFORE: ${c.criterion}` : `AFTER: ${c.pass ? "PASS" : "FAIL"}: ${c.criterion}`;
        await this.db.addArtifact(task.id, { kind: "screenshot", path: relative(this.config.artifactRoot, to), label });
        recorded++;
      }
    }
    return recorded;
  }

  /** Images the agents left in the worktree are evidence, not code: move them out before any commit. */
  private async moveStrayImages(task: Task): Promise<void> {
    const images = (await this.effects.untrackedFiles(task.worktree!)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
    if (images.length === 0) return;
    const dir = join(this.config.artifactRoot, "tasks", task.id, "stray");
    mkdirSync(dir, { recursive: true });
    for (const f of images) {
      const to = join(dir, basename(f));
      renameSync(join(task.worktree!, f), to);
      await this.db.addArtifact(task.id, { kind: "screenshot", path: relative(this.config.artifactRoot, to), label: `Left in the worktree: ${f}` });
    }
    await this.db.recordEvent(task.id, "stray_images_moved", { files: images });
  }

  /** Returns true when it sent the task back (a unit failed in the browser). */
  private async verifyUnitsInBrowser(task: Task, verify: VerifyContext): Promise<boolean> {
    const units = verifyUnits([...(task.context.lockedFiles ?? []), ...(await this.effects.diff(task.worktree!)).map((c) => c.path)], verify.dir);
    if (units.length === 0) return false;
    const run = await this.db.startAgentRun(task.id, "browser_check", "verify");
    const rel = join("tasks", task.id, run.id);
    const outDir = join(this.config.artifactRoot, rel);
    mkdirSync(outDir, { recursive: true });
    const { results, missing } = await this.effects.verifyInBrowser({ baseUrl: this.config.browserBaseUrl, entry: verify.entry, units, outDir });
    for (const r of results) {
      if (r.screenshot) await this.db.addArtifact(task.id, { kind: "screenshot", path: join(rel, r.screenshot), label: `${r.unit} / ${r.fixture}: ${r.verdict}` });
    }
    const bad = results.filter((r) => r.verdict !== "PASS");
    const feedback = [
      ...missing.map((u) => `The harness page does not list the unit ${u}: import its spec in ${verify.dir}/specs/index.ts and make sure it registers.`),
      ...bad.map((r) => `In the browser, ${r.unit} / ${r.fixture} is ${r.verdict}: ${r.failures.join("; ") || "no detail"}`),
    ];
    const summary = `${results.length - bad.length}/${results.length} fixtures pass in the browser${missing.length ? `; ${missing.length} unit(s) not listed` : ""}`;
    await this.db.finishAgentRun(run.id, { status: feedback.length ? "failed" : "passed", summary });
    await this.db.updateTask(task.id, { context: { verified: { units, passed: results.length - bad.length, total: results.length } } });
    if (feedback.length === 0) return false;
    await this.fail(task, "browser_check", `The verify specs failed in the browser: ${summary}`, feedback);
    return true;
  }

  private async publish(task: Task, output: Record<string, unknown>): Promise<void> {
    const worktree = task.worktree!;
    const branch = task.branch!;
    const title = String(output.title ?? task.title);
    // The footer carries the attribution, so drop any line the agent added.
    const agentBody = String(output.body ?? "").replace(/^.*Generated with \[Claude Code\].*$/gm, "").trim();
    const current = (await this.db.getTask(task.id))!;
    const body = `${agentBody}\n\n${factoryFooter(current)}`;
    const run = await this.db.startAgentRun(task.id, "pr", "publish");
    try {
      const message = `${title}\n\nRaised by the software factory (task ${task.id}).\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n`;
      await this.moveStrayImages(task);
      await this.effects.commitAndPush(worktree, branch, message, Boolean(task.context.forcePush));
      let pr = task.prNumber;
      if (pr) {
        // Back to draft while the change is not green again, so the merge agent does not merge it mid-fix.
        await this.effects.setReady(worktree, pr, false);
        await this.effects.updatePrBody(worktree, pr, body);
      } else pr = await this.effects.createPr(worktree, branch, title, body);
      await this.db.updateTask(task.id, {
        prNumber: pr,
        // The first PR starts a fresh retry budget; later rounds (failed checks) share it, so they cannot loop forever.
        ...(task.prNumber ? {} : { attempts: 0 }),
        context: {
          prTitle: task.context.prTitle ?? title,
          prBody: agentBody,
          prOpenedAt: task.context.prOpenedAt ?? this.now().toISOString(),
          lastPushAt: this.now().toISOString(),
          readyAt: undefined,
          forcePush: undefined,
          feedback: [],
        },
      });
      await this.db.finishAgentRun(run.id, { status: "passed", summary: `PR #${pr}` });
    } catch (error) {
      await this.db.finishAgentRun(run.id, { status: "error", summary: (error as Error).message.slice(0, 500) });
      throw error;
    }
    return this.move(task, afterSuccess("pr"));
  }

  /**
   * Watch the PR until someone else merges it. The factory never merges. It sends
   * failing checks and requested changes back to implement, marks the PR ready with its risk label once CI is
   * green, and moves to done when the PR is merged.
   */
  private async watchPr(task: Task): Promise<void> {
    const worktree = task.worktree!;
    const pr = task.prNumber;
    if (!pr) return this.escalate(task, "The task reached the merge stage with no pull request.");
    const status = await this.effects.prStatus(worktree, pr);
    if (status.state === "MERGED") {
      await this.db.recordEvent(task.id, "pr_merged", { pr, headSha: status.headSha });
      return this.move(task, afterSuccess("awaiting_merge"));
    }
    if (status.state === "CLOSED") return this.escalate(task, `PR #${pr} was closed without a merge.`);

    // A conflict with the base (seen here, or asked for with `factory sync`): move the change onto the base.
    if (status.conflicting || task.context.syncRequested) return this.sync(task, pr);

    const since = Date.parse(task.context.lastPushAt ?? "") || 0;
    const requests = status.changesRequested.filter((r) => Date.parse(r.at) > since);
    if (requests.length > 0) {
      // A review round: the reviewer may need a test changed, so the lock is lifted.
      await this.db.updateTask(task.id, { context: { lockedFiles: [], readyAt: undefined } });
      return this.fail(
        task,
        "awaiting_merge",
        `Changes were requested on PR #${pr}`,
        requests.map((r) => `${r.by} asked for changes on the pull request: ${r.body}`),
      );
    }
    if (status.checks === "fail") {
      return this.fail(task, "awaiting_merge", `Checks failed on PR #${pr}`, status.failures.map((f) => `A check failed on the pull request: ${f}`));
    }
    if (status.checks === "pending") return this.wait(task);
    if (status.isDraft || !task.context.readyAt) {
      const risk = task.context.risk?.level === "high" ? "high" : "low";
      await this.effects.setReady(worktree, pr, true);
      await this.db.updateTask(task.id, { context: { readyAt: this.now().toISOString() } });
      await this.db.recordEvent(task.id, "pr_ready", { pr, headSha: status.headSha, risk });
      return;
    }
    return this.wait(task);
  }

  /**
   * Conflict resolution. The change is re-applied onto the latest base. Clean: run the gate here and
   * push (force, with lease). Conflicts: implement resolves the markers, and the whole pipeline runs again.
   */
  private async sync(task: Task, pr: number): Promise<void> {
    const worktree = task.worktree!;
    const run = await this.db.startAgentRun(task.id, "awaiting_merge", "sync");
    let result: { upToDate: boolean; conflicts: string[] };
    try {
      result = await this.effects.syncWithBase(worktree);
    } catch (error) {
      await this.db.finishAgentRun(run.id, { status: "error", summary: (error as Error).message.slice(0, 500) });
      throw error;
    }
    await this.db.finishAgentRun(run.id, {
      status: result.conflicts.length ? "failed" : "passed",
      output: result,
      summary: result.upToDate ? "Already on the latest base" : result.conflicts.length ? `Conflicts in ${result.conflicts.join(", ")}` : "Moved onto the latest base, no conflicts",
    });
    await this.db.recordEvent(task.id, "synced_with_base", { pr, ...result });
    await this.db.updateTask(task.id, { context: { syncRequested: undefined, readyAt: undefined, forcePush: !result.upToDate } });
    if (result.conflicts.length) {
      await this.effects.setReady(worktree, pr, false);
      await this.db.updateTask(task.id, {
        attempts: 0,
        context: {
          feedback: [
            `The base branch moved and this change now conflicts with it. Resolve the conflict markers in these files, keeping both sides' intent: ${result.conflicts.join(", ")}.`,
          ],
        },
      });
      return this.move(task, "implementing");
    }
    if (result.upToDate) return;
    const gate = await this.effects.gate(worktree, await this.effects.diff(worktree));
    if (!gate.ok) {
      return this.fail(task, "awaiting_merge", `The gate failed after moving onto the base: ${gate.steps.filter((s) => !s.ok).map((s) => s.name).join(", ")}`, failedSteps(gate, "after the move onto the latest base"));
    }
    await this.effects.commitAndPush(worktree, task.branch!, `Move onto the latest base\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n`, true);
    await this.effects.setReady(worktree, pr, false);
    await this.db.updateTask(task.id, { context: { forcePush: undefined, lastPushAt: this.now().toISOString() } });
  }
}

export function factoryFooter(task: Task): string {
  const c = task.context;
  const risk = !c.risk ? "Not checked." : c.risk.level === "high" ? `High:\n${c.risk.reasons.map((r) => `  - ${r}`).join("\n")}` : "Normal. No protected path changed.";
  return [
    "## Simple Software Factory",
    "",
    `The Simple Software Factory raised this pull request for task \`${task.id}\`${task.ticketKey ? ` (${task.ticketKey})` : ""}. The orchestrator compared lint, type errors and the changed tests with the merge base and found nothing new. It marks the PR ready for review once CI is green; it never merges.`,
    "",
    `- Risk: ${risk}`,
    ...(Object.keys(task.phaseModels).length ? [`- Model overrides: ${Object.entries(task.phaseModels).map(([p, m]) => `${p} ${m}`).join(", ")}`] : []),
    `- Estimated agent cost: $${task.costUsd.toFixed(2)}`,
    ...(c.noTestsReason ? [`- No new unit tests: ${c.noTestsReason}`] : []),
    ...(c.verified ? [`- UI units checked in the browser: ${c.verified.units.join(", ")} (${c.verified.passed}/${c.verified.total} fixtures pass)`] : []),
    ...(c.untested ?? []).map((u) => `- Not checked in the browser: ${u.criterion} (${u.reason})`),
    ...(c.decisions?.length ? ["", "### Decisions the decider made", "", ...c.decisions.map((d) => `- ${d.stage}: ${d.question} **${d.answer}**`)] : []),
    ...(c.followUps?.length ? ["", "### Follow-ups", "", ...c.followUps.map((f) => `- ${f}`)] : []),
    "",
    "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  ].join("\n");
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];
}

function summaryOf(output: unknown): string | null {
  const summary = (output as { summary?: unknown } | null)?.summary;
  return typeof summary === "string" ? summary.slice(0, 1000) : null;
}

function failedSteps(result: GateResult, where = ""): string[] {
  return result.steps.filter((s) => !s.ok).map((s) => `\`${s.name}\` failed${where ? ` ${where}` : ""}:\n${s.output.slice(-3000)}`);
}

export async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, intervalMs = Math.min(2000, timeoutMs)): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
