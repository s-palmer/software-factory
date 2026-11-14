/**
 * The product manager run: an idea (an intake issue or a draft spec) becomes a spec
 * and a checked ticket plan, filed as GitHub issues, with one factory task per ticket and its blockers.
 *
 * Plain code around one agent: the PM only writes the spec file and returns JSON. Code checks the plan, sends
 * failures back as feedback, asks the decider about questions, files the issues and creates the tasks.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Task } from "../../shared/api";
import { modelFor } from "../../shared/models";
import type { ClaudeCall } from "../claude";
import { DuplicateTicketError, type FactoryDb } from "../db";
import { run as runCommand } from "../effects";
import type { Effects } from "../orchestrator";
import { BUDGETS, DEFAULT_SKILLS_DIR, deciderCall, denyTools } from "../phases";
import { filePlan, parseMarker, specLabel, type FilingResult, type IssueTracker } from "./filing";
import { checkPlan, orderTickets, PLAN_JSON_SCHEMA, PlanOutput } from "./plan";

export type PlanStatus = "running" | "filed" | "dry_run" | "escalated" | "failed";

export interface PlannerConfig {
  /** Where the factory's project lives in the repository (for the parent issue's source line). */
  projectDir: string;
  base: string;
  maxAttempts: number;
  artifactRoot: string;
  /** Write the bodies to the artifacts and file nothing (FACTORY_DRY_RUN_PLAN). */
  dryRun: boolean;
  /** The skills folder and the PM run's skill files, when the project replaces the defaults. */
  skillsDir?: string;
  skillFiles?: string[];
}

/** `gh` as the issue tracker. Runs in the repository; reads and writes go through fixed commands only. */
export function ghTracker(repo: string): IssueTracker {
  const gh = async (args: string[]) => {
    const r = await runCommand(["gh", ...args], repo);
    if (r.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${(r.stderr || r.stdout).trim().slice(-800)}`);
    return r.stdout.trim();
  };
  const withBody = async <T>(body: string, fn: (file: string) => Promise<T>): Promise<T> => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "factory-issue-"));
    const file = join(dir, "body.md");
    writeFileSync(file, body);
    try {
      return await fn(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  return {
    async listIssues(label) {
      const raw = await gh(["issue", "list", "--label", label, "--state", "all", "--limit", "500", "--json", "number,title,body,state"]);
      return (JSON.parse(raw || "[]") as Array<{ number: number; title: string; body: string; state: string }>).map((i) => ({
        ...i,
        state: i.state.toLowerCase() === "open" ? "open" : "closed",
      }));
    },
    createIssue: ({ title, body, labels }) =>
      withBody(body, async (file) => {
        const url = await gh(["issue", "create", "--title", title, "--body-file", file, ...labels.flatMap((l) => ["--label", l])]);
        const n = Number(/\/issues\/(\d+)/.exec(url)?.[1]);
        if (!n) throw new Error(`gh issue create gave no number: ${url}`);
        return n;
      }),
    editIssue: async (n, { title, body }) => {
      await withBody(body ?? "", (file) => gh(["issue", "edit", String(n), ...(title ? ["--title", title] : []), ...(body !== undefined ? ["--body-file", file] : [])]));
    },
    ensureLabel: async (name, color, description) => {
      await gh(["label", "create", name, "--color", color, "--description", description, "--force"]);
    },
    comment: async (n, body) => {
      await withBody(body, (file) => gh(["issue", "comment", String(n), "--body-file", file]));
    },
  };
}

const READ = ["Read", "Grep", "Glob", "Bash(git log:*)", "Bash(git diff:*)", "Bash(gh issue view:*)", "Bash(gh issue list:*)"];

/** The skills the PM run follows, relative to the skills folder. */
export const PLANNING_SKILLS = ["to-spec/SKILL.md", "to-tickets/SKILL.md"];

export function pmCall(source: string, opts: { model: string; feedback: string[]; specPath: string | null; skillsDir?: string; skillFiles?: string[] }): ClaudeCall {
  const skills = opts.skillsDir ?? DEFAULT_SKILLS_DIR;
  const files = (opts.skillFiles ?? PLANNING_SKILLS).map((f) => `\`${join(skills, f)}\``).join(" and ");
  const what = source.startsWith("#")
    ? `The idea is GitHub issue ${source}. Read it with \`gh issue view ${source.slice(1)} --comments\`.`
    : `The idea is the draft spec \`${source}\`. Rewrite it in place in the spec format.`;
  const target = opts.specPath ? `Write the spec to \`${opts.specPath}\`.` : "Write the spec to `specs/<short-kebab-name>.md`.";
  const feedback = opts.feedback.length ? `\n## Feedback from the last attempt. Address every item\n\n${opts.feedback.map((f) => `- ${f}`).join("\n")}\n` : "";
  const prompt = `# Phase: planning

You are the factory's product manager. ${what}

1. Read ${files} and follow their formats, with these overrides: do not interview or quiz anyone, do not publish to any tracker (the factory files the issues), and do not check seams with a user. Look at \`specs/\` for existing specs, the codebase, and existing issues (\`gh issue list --label factory --state all --limit 200\`), so you do not plan work that exists.
2. ${target} Use the template's sections exactly: Problem Statement, Solution, User Stories (a long numbered list), Implementation Decisions, Testing Decisions, Out of Scope, Further Notes.
3. Return the ticket plan: vertical-slice tickets (at most 15), each with a key like \`ABC-01\` (one prefix per spec, stable across re-runs), a size, the tickets that block it, what it builds (behaviour, no file paths), testable acceptance criteria, and \`stories\`: the numbers of the user stories it covers. Every user story must be covered by a ticket or listed in \`deferred\` as "Story N: <reason>".
4. Questions you cannot settle from the idea, the code or the repository go in \`questions\`; a decider answers them.
${feedback}`;
  return {
    prompt,
    allowedTools: [...READ, "Write(specs/**)", "Edit(specs/**)"],
    disallowedTools: denyTools(),
    addDirs: [skills],
    mcpServers: {},
    outputSchema: PLAN_JSON_SCHEMA,
    maxBudgetUsd: BUDGETS.planning,
    model: opts.model,
  };
}

export class Planner {
  private readonly busy = new Set<string>();

  constructor(
    private readonly db: FactoryDb,
    private readonly effects: Effects,
    private readonly tracker: IssueTracker,
    private readonly config: PlannerConfig,
  ) {}

  /** Start a plan for a source ("#12" or "specs/x.md"). Returns the plan id; the run continues in the background. */
  async start(source: string, by = "human"): Promise<string> {
    const plan = await this.db.createPlan(source, by);
    void this.run(plan.id);
    return plan.id;
  }

  /** Start a plan for every open `factory:intake` issue that has none yet. Returns the plan ids started. */
  async pollIntake(): Promise<string[]> {
    const intake = (await this.tracker.listIssues("factory:intake")).filter((i) => i.state === "open");
    const planned = new Set((await this.db.listPlans(500)).map((p) => p.source));
    const started: string[] = [];
    for (const issue of intake) if (!planned.has(`#${issue.number}`)) started.push(await this.start(`#${issue.number}`, "factory"));
    return started;
  }

  /** Run a plan to the end: PM, checks, decider, filing, tasks. Never throws; failures land on the plan. */
  async run(planId: string): Promise<void> {
    if (this.busy.has(planId)) return;
    this.busy.add(planId);
    try {
      await this.attempt(planId);
    } catch (error) {
      await this.db.updatePlan(planId, { status: "failed", error: (error as Error).message.slice(0, 2000) });
    } finally {
      this.busy.delete(planId);
    }
  }

  private async attempt(planId: string): Promise<void> {
    const plan = (await this.db.getPlan(planId))!;
    // The plan works in its own worktree, so the spec it writes goes through a PR like any change.
    const pseudoTask = { id: planId, title: `plan ${plan.source.replace(/^#/, "issue ")}`, ticketKey: null } as unknown as Task;
    const { branch, worktree } = await this.effects.createWorktree(pseudoTask);
    const defaults = await this.db.getDefaultModels();
    const filed = await this.tracker.listIssues("factory");
    const openTitles = filed.filter((i) => i.state === "open").map((i) => i.title);

    let feedback: string[] = [];
    let deciderUsed = false;
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      const model = modelFor("planning", defaults);
      const run = await this.db.startAgentRun(planId, "backlog", "planning", model);
      const runDir = join(this.config.artifactRoot, "plans", planId, run.id);
      mkdirSync(runDir, { recursive: true });
      const result = await this.effects.claude(pmCall(plan.source, {
          model,
          feedback,
          specPath: plan.specPath,
          ...(this.config.skillsDir ? { skillsDir: this.config.skillsDir } : {}),
          ...(this.config.skillFiles ? { skillFiles: this.config.skillFiles } : {}),
        }), { cwd: worktree, runDir });
      await this.db.finishAgentRun(run.id, {
        status: result.ok ? "passed" : "failed",
        costUsd: result.costUsd,
        turns: result.turns,
        output: result.output,
        summary: result.ok ? String((result.output as { summary?: string } | null)?.summary ?? "").slice(0, 1000) : `${result.subtype}: ${result.text.slice(0, 500)}`,
        logPath: result.logPath,
      });
      if (!result.ok) return void (await this.db.updatePlan(planId, { status: "escalated", error: `The PM run stopped: ${result.subtype}. ${result.text.slice(0, 500)}` }));

      const parsed = PlanOutput.safeParse(result.output);
      const output = parsed.success ? parsed.data : null;
      const specPath = output?.spec.path ?? null;
      const specText = specPath && existsSync(join(worktree, specPath)) ? readFileSync(join(worktree, specPath), "utf8") : null;

      // Questions go to the decider once; its answers go back to the PM as feedback.
      if (output && output.questions.length > 0) {
        if (deciderUsed) return void (await this.db.updatePlan(planId, { status: "escalated", output, error: `Open questions: ${output.questions.join(" ")}` }));
        deciderUsed = true;
        const answers = await this.decide(planId, plan.source, output.questions, output.summary, worktree, modelFor("decider", defaults));
        if (!answers) return void (await this.db.updatePlan(planId, { status: "escalated", output, error: `Questions the decider could not settle: ${output.questions.join(" ")}` }));
        feedback = answers;
        attempt--;
        continue;
      }

      const filedKeys = new Set(
        filed.map((i) => parseMarker(i.body)).filter((m): m is { path: string; key: string } => Boolean(m?.key && m.path === specPath)).map((m) => m.key),
      );
      const checks = checkPlan(result.output, { specText, filedKeys, openIssueTitles: openTitles });
      await this.db.updatePlan(planId, { output: result.output, checks, specPath, attempts: attempt });
      if (!checks.ok || !output || !specPath || specText === null) {
        feedback = checks.failures.length ? checks.failures : [`The spec file ${specPath ?? "(none)"} does not exist in the worktree.`];
        continue;
      }
      return this.file(planId, output, specText, branch, worktree, plan.source);
    }
    await this.db.updatePlan(planId, { status: "escalated", error: `The plan failed its checks ${this.config.maxAttempts} times: ${feedback.join(" ")}` });
  }

  private async decide(planId: string, source: string, questions: string[], summary: string, worktree: string, model: string): Promise<string[] | null> {
    const run = await this.db.startAgentRun(planId, "backlog", "decider", model);
    const runDir = join(this.config.artifactRoot, "plans", planId, run.id);
    mkdirSync(runDir, { recursive: true });
    const task = { id: planId, title: `Plan for ${source}`, ticketKey: source.startsWith("#") ? source : null, description: "" } as unknown as Task;
    const ctx = { model, feedback: [], lockedFiles: [], browserUrl: "", browserPlan: [] };
    const result = await this.effects.claude(deciderCall(task, ctx, "scoping", questions, summary), { cwd: worktree, runDir });
    await this.db.finishAgentRun(run.id, { status: result.ok ? "passed" : "failed", costUsd: result.costUsd, turns: result.turns, output: result.output, logPath: result.logPath });
    const decisions = ((result.output as { decisions?: unknown } | null)?.decisions ?? []) as Array<{ question: string; answer: string; needsHuman: boolean }>;
    if (!result.ok || decisions.length === 0 || decisions.some((d) => d.needsHuman)) return null;
    return decisions.map((d) => `${d.question} Decision: ${d.answer}`);
  }

  private async file(planId: string, output: PlanOutput, specText: string, branch: string, worktree: string, source: string): Promise<void> {
    const run = await this.db.startAgentRun(planId, "backlog", "filing");
    const dryRun = this.config.dryRun;
    let filing: FilingResult;
    try {
      filing = await filePlan(output, this.tracker, {
        specText,
        projectDir: this.config.projectDir,
        branch,
        dryRun,
        ...(source.startsWith("#") ? { intakeIssue: Number(source.slice(1)) } : {}),
        // A filed ticket is edited only while its task has not started.
        editable: () => true,
      });
    } catch (error) {
      await this.db.finishAgentRun(run.id, { status: "error", summary: (error as Error).message.slice(0, 500) });
      throw error;
    }
    const bodiesFile = join(this.config.artifactRoot, "plans", planId, "issues.json");
    mkdirSync(dirname(bodiesFile), { recursive: true });
    writeFileSync(bodiesFile, JSON.stringify(filing.bodies, null, 2));
    await this.db.finishAgentRun(run.id, {
      status: "passed",
      output: { parent: filing.parent, tickets: filing.tickets, created: filing.created, updated: filing.updated, removed: filing.removed },
      summary: dryRun ? `Dry run: ${filing.bodies.length} issue bodies written to ${bodiesFile}` : `Filed #${filing.parent}: ${filing.created.length} created, ${filing.updated.length} updated`,
    });
    if (dryRun) return void (await this.db.updatePlan(planId, { status: "dry_run", filing }));

    // The plan file with issue numbers goes next to the spec, through a PR like any change.
    const ticketsPath = output.spec.path.replace(/\.md$/, ".tickets.json");
    const planFile = {
      spec: output.spec.path,
      labels: ["factory", "ready-for-agent", specLabel(output.spec.path)],
      parentIssue: filing.parent,
      tickets: output.tickets.map((t) => ({ ...t, issue: filing.tickets[t.key] })),
    };
    writeFileSync(join(worktree, ticketsPath), `${JSON.stringify(planFile, null, 2)}\n`);
    await this.effects.commitAndPush(worktree, branch, `Plan: ${output.spec.title}\n\nSpec and tickets from the factory's PM (plan ${planId}, ${source}).\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n`);
    const pr = await this.effects.createPr(worktree, branch, `Plan: ${output.spec.title}`, `The factory's PM planned ${source} as #${filing.parent}.\n\n- Spec: \`${output.spec.path}\`\n- Tickets: \`${ticketsPath}\`\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`);

    // One task per ticket, blockers first, with the blockers in the same request.
    const tasks: Record<string, string> = {};
    for (const t of orderTickets(output)) {
      const ticket = `#${filing.tickets[t.key]}`;
      const blockedBy = t.blockedBy.map((k) => filing.tickets[k]).filter((n): n is number => Boolean(n)).map((n) => `#${n}`);
      try {
        tasks[t.key] = (await this.db.createTask({ title: ticket, description: "", ticketKey: ticket, blockedBy, phaseModels: t.phaseModels ?? {} }, "backlog", "factory")).id;
      } catch (error) {
        if (!(error instanceof DuplicateTicketError)) throw error;
        tasks[t.key] = error.taskId;
      }
    }
    await this.db.updatePlan(planId, { status: "filed", filing, prNumber: pr, tasks });
  }
}
