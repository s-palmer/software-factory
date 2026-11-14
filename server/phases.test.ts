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
    expect(p("scoping")).toContain("Do not write to the tracker or to GitHub");
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

describe("tickets", () => {
  it("puts a GitHub issue the factory read into the prompt, and gives agents no GitHub access", () => {
    const withIssue = { ...task, context: { ticket: { title: "Paginate", body: "10 per page", url: "https://github.com/o/r/issues/42", comments: ["bob: and a page size picker?"] } } } as Task;
    const call = phaseCall("scoping", withIssue, ctx);
    expect(call.prompt).toContain("GitHub issue #42 (https://github.com/o/r/issues/42)");
    expect(call.prompt).toContain("10 per page");
    expect(call.prompt).toContain("bob: and a page size picker?");
    expect(call.disallowedTools).toContain("Bash(gh:*)");
    expect(call.allowedTools.some((t) => t.startsWith("Bash(gh"))).toBe(false);
  });

  it("gives every run the tracker's MCP server and only its read tools", () => {
    const jira = { label: "Jira", name: "jira", server: { type: "http", url: "https://mcp.atlassian.com/v2/mcp" }, tools: ["getJiraIssue"], instructions: "Use getJiraIssue." };
    const jiraTask = { ...task, ticketKey: "LI-12" } as Task;
    for (const call of [phaseCall("implementing", jiraTask, { ...ctx, tracker: jira }), deciderCall(jiraTask, { ...ctx, tracker: jira }, "design", ["q"], "")]) {
      expect(call.mcpServers).toEqual({ jira: jira.server });
      expect(call.allowedTools).toContain("mcp__jira__getJiraIssue");
      expect(call.prompt).toContain("Jira ticket LI-12. Use getJiraIssue.");
    }
    expect(phaseCall("scoping", jiraTask, { ...ctx, tracker: jira }).prompt).toContain("docs/designs/li-12-solution.md");
    const linear = phaseCall("scoping", jiraTask, { ...ctx, tracker: { ...jira, name: "linear", tools: "*" } });
    expect(linear.allowedTools).toContain("mcp__linear");
  });
});

describe("isolation", () => {
  const isolation = { allowRead: ["/f/worktrees/t1"], denyRead: ["/home/u", "/f"], denyWrite: ["/skills"], allowedDomains: ["registry.npmjs.org"] };

  it("sandboxes every run and keeps file tools inside the working folders", () => {
    for (const call of [phaseCall("reviewing", task, { ...ctx, isolation }), deciderCall(task, { ...ctx, isolation }, "design", ["q"], "")]) {
      const s = call.settings as { permissions: { blockReadsOutsideWorkingDirectories: boolean; deny: string[] }; sandbox: { enabled: boolean; allowUnsandboxedCommands: boolean; filesystem: { allowRead: string[]; denyRead: string[] }; network: { allowedDomains: string[] } } };
      expect(s.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
      expect(s.permissions.deny).toContain("Read(~/.ssh/**)");
      expect(s.permissions.deny).not.toContain("Read(//f/**)");
      expect(s.sandbox).toMatchObject({ enabled: true, allowUnsandboxedCommands: false, network: { allowedDomains: ["registry.npmjs.org"] } });
      expect(s.sandbox.filesystem.allowRead).toEqual(["/f/worktrees/t1"]);
      expect(s.sandbox.filesystem.denyRead).toEqual(expect.arrayContaining(["~/.ssh", "/home/u", "/f"]));
    }
  });

  it("keeps the locked-file hook next to the sandbox in the implement run", () => {
    const hook = { hooks: { PreToolUse: [{ matcher: "Write" }] } };
    const s = phaseCall("implementing", task, { ...ctx, isolation, settings: hook }).settings as { hooks: unknown; sandbox: { enabled: boolean } };
    expect(s.hooks).toEqual(hook.hooks);
    expect(s.sandbox.enabled).toBe(true);
    expect(phaseCall("implementing", task, ctx).settings).toBeUndefined();
  });
});

describe("replaceable skills", () => {
  it("reads the project's own skills for a stage, with only the rules every stage needs", () => {
    const call = phaseCall("design", task, { ...ctx, skillsDir: "/code/app/.claude/skills", stageSkills: { design: ["architecture/SKILL.md"] } });
    expect(call.prompt).toContain("`/code/app/.claude/skills/architecture/SKILL.md`");
    expect(call.prompt).not.toContain("DESIGN-IT-TWICE");
    expect(call.prompt).toContain("Do not commit, push or open a pull request");
    expect(call.addDirs).toEqual(["/code/app/.claude/skills"]);
    // A stage left out keeps the default files, in the project's folder.
    expect(phaseCall("scoping", task, { ...ctx, skillsDir: "/code/app/.claude/skills", stageSkills: { design: ["x.md"] } }).prompt).toContain("`/code/app/.claude/skills/to-spec/SKILL.md`");
  });
});

