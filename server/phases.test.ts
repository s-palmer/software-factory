// @vitest-environment node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Task } from "../shared/api";
import { type AgentStage, DEFAULT_SKILLS_DIR, deciderCall, denyTools, PHASE_SKILLS, type PhaseContext, phaseCall } from "./phases";

// Only the fields the prompt builders read.
const task = { id: "0123456789abcdef", title: "Paginate the task list", ticketKey: "#42", description: "Show 10 per page." } as Task;
const ctx: PhaseContext = { model: "m", feedback: [], lockedFiles: [], browserUrl: "http://localhost:5173", browserPlan: [] };
const STAGES: AgentStage[] = ["scoping", "design", "test_writing", "implementing", "reviewing", "browser_check", "pr"];

const expected: Record<AgentStage, string[]> = {
  scoping: ["to-spec/SKILL.md"],
  design: ["codebase-design/SKILL.md", "domain-modeling/SKILL.md"],
  test_writing: ["tdd/SKILL.md", "tdd/tests.md"],
  implementing: ["implement/SKILL.md", "tdd/SKILL.md"],
  reviewing: ["code-review/SKILL.md"],
  browser_check: [],
  pr: ["pr/SKILL.md"],
};

describe("phase skills", () => {
  it.each(STAGES)("%s names its skill files, and each exists", (stage) => {
    const { prompt } = phaseCall(stage, task, ctx);
    for (const f of expected[stage]) expect(prompt).toContain(`\`${join(DEFAULT_SKILLS_DIR, f)}\``);
    expect(PHASE_SKILLS[stage].filter((f) => !existsSync(join(DEFAULT_SKILLS_DIR, f)))).toEqual([]);
    expect(prompt.includes("## How to work")).toBe(PHASE_SKILLS[stage].length > 0);
    expect(prompt).toMatch(/^# Phase: /);
  });

  it("browser check and decider follow no skill", () => {
    expect(phaseCall("browser_check", task, ctx).prompt).not.toContain("## How to work");
    const decider = deciderCall(task, ctx, "design", ["Paginate or scroll?"], "");
    expect(decider.prompt).not.toContain(".claude/skills/");
    expect(decider.prompt).not.toContain("## How to work");
  });

  it("states the factory overrides", () => {
    const p = (s: AgentStage, c: PhaseContext = ctx) => phaseCall(s, task, c).prompt;
    expect(p("scoping")).toContain("Problem Statement");
    expect(p("scoping")).toContain("gh issue view");
    expect(p("design")).toContain("Do not use DESIGN-IT-TWICE");
    expect(p("test_writing")).toContain("not confirmed with a user");
    expect(p("test_writing")).toContain("Write all the tests for the task list now");
    expect(p("implementing")).toContain("Do not commit");
    expect(p("implementing")).toContain("Do not run code-review");
    expect(p("reviewing")).toContain("No sub-agents");
    expect(p("reviewing")).toContain("git diff --merge-base origin/main");
    expect(p("reviewing")).toContain("origin/main...HEAD");
    expect(p("reviewing", { ...ctx, baseBranch: "factory/main" })).toContain("git diff --merge-base origin/factory/main");
    expect(p("pr")).toContain("Merge Danger");
    expect(p("pr")).toContain("Do not add an attribution line");
  });

  it("denies sub-agents and questions to every run", () => {
    const calls = [...STAGES.map((s) => phaseCall(s, task, ctx)), deciderCall(task, ctx, "scoping", ["q"], "s")];
    for (const call of calls) expect(call.disallowedTools).toEqual(expect.arrayContaining(["Task", "Agent", "AskUserQuestion"]));
  });

  it("still renders feedback and locked files", () => {
    const call = phaseCall("implementing", task, { ...ctx, feedback: ["off by one"], lockedFiles: ["src/a.test.ts"] });
    expect(call.prompt).toContain("## Feedback from the last attempt");
    expect(call.prompt).toContain("- off by one");
    expect(call.prompt).toContain("Locked test files");
  });

  it("reads the skills from the factory, outside the worktree", () => {
    const call = phaseCall("design", task, { ...ctx, skillsDir: "/opt/factory/skills" });
    expect(call.prompt).toContain("`/opt/factory/skills/codebase-design/SKILL.md`");
    expect(call.addDirs).toEqual(["/opt/factory/skills"]);
    expect(phaseCall("browser_check", task, ctx).addDirs).toEqual([]);
  });
});

describe("tool rules from the project config", () => {
  const tools = { run: ["npm run lint", "npx --no-install vitest run"], deny: ["npm ci", "npm run dev"] };

  it("lets the code phases run the project's checks", () => {
    const call = phaseCall("implementing", task, { ...ctx, tools });
    expect(call.allowedTools).toEqual(expect.arrayContaining(["Bash(npm run lint:*)", "Bash(npx --no-install vitest run:*)"]));
    expect(call.allowedTools.some((t) => t.includes("pnpm"))).toBe(false);
    expect(phaseCall("reviewing", task, { ...ctx, tools }).allowedTools).not.toContain("Bash(npm run lint:*)");
  });

  it("denies the install and start commands, and npx unless a check uses it", () => {
    const deny = denyTools(tools);
    expect(deny).toEqual(expect.arrayContaining(["Bash(npm ci:*)", "Bash(npm run dev:*)", "Bash(npm install:*)", "Bash(bunx:*)"]));
    expect(deny).not.toContain("Bash(npx:*)");
    expect(denyTools()).toContain("Bash(npx:*)");
  });
});

