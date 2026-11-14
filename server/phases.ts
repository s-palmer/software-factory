/**
 * What each agent phase gets: prompt, tools, output schema, budget.
 * Pure: builds `ClaudeCall`s, runs nothing.
 */
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Task } from "../shared/api";
import type { Phase } from "../shared/models";
import type { ClaudeCall } from "./claude";

export type AgentStage = "scoping" | "design" | "test_writing" | "implementing" | "reviewing" | "browser_check" | "pr";

export type BrowserStep = { criterion: string; path: string; steps: string };

export interface PhaseContext {
  model: string;
  feedback: string[];
  lockedFiles: string[];
  browserUrl: string;
  browserPlan: BrowserStep[];
  /** The Playwright MCP server entry for the browser check (a pinned package, started outside the repo). */
  browserMcp?: Record<string, unknown> | undefined;
  /** Pre-tool-use hook settings that refuse edits to locked files (implement only). */
  settings?: object | undefined;
  /** The base branch on `origin` that review and PR text diff against. Default "main". */
  baseBranch?: string | undefined;
  /** The project's commands: the code phases may run `run`, and no phase may run `deny`. Default: the pnpm preset. */
  tools?: ToolRules | undefined;
  /** Where the phase skills live. Default: this install's `.claude/skills`. */
  skillsDir?: string | undefined;
  /** A ticket system behind MCP. Without it, the ticket is a GitHub issue the factory already read. */
  tracker?: PhaseTracker | undefined;
  /** What the run may touch. Without it, a run gets only the fixed denies (tests of prompt building). */
  isolation?: Isolation | undefined;
  /** Runtime verification for UI units, when the project has it (`verify` in the config). */
  verify?: VerifyContext | undefined;
}

/** `dir`: the framework's folder from the project folder. `entry`: the harness page in the running app. */
export type VerifyContext = { dir: string; entry: string };

const VERIFY_FRAMEWORK = ["core", "verifiers", "harness"];

/** What each stage does about verify specs. */
function verifyRules(stage: AgentStage, v: VerifyContext): string {
  const guide = `\`${v.dir}/README.md\``;
  switch (stage) {
    case "design":
      return `\n## UI units\n\nThis project checks UI components with runtime verification (${guide}). In the task list, name each UI component this change adds or changes as a unit, with the DOM contract it will emit (the \`verifyAttrs\` keys and what each means) and the fixtures that matter, including at least one edge case.\n`;
    case "test_writing":
      return `\n## UI units\n\nThis project checks UI components with runtime verification. Read ${guide}. For each UI unit in the task list, write \`${v.dir}/specs/<Unit>.verify.ts\` with fixtures (at least one \`probe: true\`) and invariants on the DOM contract, and import it in \`${v.dir}/specs/index.ts\`. Return the spec files and \`${v.dir}/specs/index.ts\` in \`testFiles\` with your other tests; the factory runs them through \`${v.dir}/matrix.test.ts\`.\n`;
    case "implementing":
      return `\n## UI units\n\nThe locked \`.verify.ts\` specs describe each UI unit. Its root element must spread \`verifyAttrs({ unit: "<Id>", ...state })\` (from \`${v.dir}/core/contract\`) with the keys its spec reads. Do not change ${VERIFY_FRAMEWORK.map((d) => `\`${v.dir}/${d}/\``).join(", ")}: they judge your work. The factory opens each unit's fixtures in the browser after review.\n`;
    default:
      return "";
  }
}

/** The framework's folders: no phase may edit them. */
function verifyDenies(v: VerifyContext | undefined): object | undefined {
  if (!v) return undefined;
  return { permissions: { deny: VERIFY_FRAMEWORK.map((d) => `Edit(./${v.dir}/${d}/**)`) } };
}

export type PhaseTracker = { label: string; name: string; server: Record<string, unknown>; tools: string[] | "*"; instructions: string };

/**
 * The run's limits. File tools may not leave the working folders (the run's cwd and `--add-dir`). Shell commands,
 * and every process they start (a test runner running code the agent wrote), run in Claude Code's OS sandbox:
 * no reads of `denyRead` (the factory's state, other worktrees, the repository checkout, credentials) except
 * `allowRead`, writes only in the cwd and the temp folder, and network only to `allowedDomains`.
 */
export type Isolation = { allowRead: string[]; denyRead: string[]; denyWrite: string[]; allowedDomains: string[] };

/** Credential folders no run may read, also outside the sandbox (the Read tool follows permission rules only). */
export const SECRET_PATHS = ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gh", "~/.docker", "~/.kube", "~/.netrc", "~/.npmrc", "~/.claude.json", "~/.claude"];

export function isolationSettings(iso: Isolation): object {
  const rule = (p: string) => (p.startsWith("~/") ? p : `/${p}`);
  return {
    permissions: {
      blockReadsOutsideWorkingDirectories: true,
      blockWritesOutsideWorkingDirectories: true,
      // Only the credential folders: a deny rule also refuses shell commands that touch the path, and the worktree
      // lies inside the denied folders. The file tools stay in the working folders through the two block keys.
      deny: SECRET_PATHS.flatMap((p) => [`Read(${rule(p)}/**)`, `Edit(${rule(p)}/**)`]),
    },
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      filesystem: { denyRead: [...SECRET_PATHS, ...iso.denyRead], allowRead: iso.allowRead, denyWrite: iso.denyWrite },
      network: { allowedDomains: iso.allowedDomains },
    },
  };
}

/** Deep-merges Claude Code settings objects; arrays are joined. */
export function mergeSettings(...parts: Array<object | undefined>): object | undefined {
  const defined = parts.filter((p): p is object => p !== undefined);
  if (defined.length === 0) return undefined;
  const merge = (a: unknown, b: unknown): unknown => {
    if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
    if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
      const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
      for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k], v) : v;
      return out;
    }
    return b;
  };
  return defined.reduce((acc, p) => merge(acc, p) as object);
}

/** The tracker's MCP server and its read tools, for every run that reads the ticket. */
function trackerAccess(ctx: PhaseContext): { tools: string[]; servers: Record<string, unknown> } {
  const t = ctx.tracker;
  if (!t) return { tools: [], servers: {} };
  return { tools: t.tools === "*" ? [`mcp__${t.name}`] : t.tools.map((tool) => `mcp__${t.name}__${tool}`), servers: { [t.name]: t.server } };
}

export type ToolRules = { run: string[]; deny: string[] };

const DEFAULT_TOOLS: ToolRules = {
  run: ["pnpm run lint", "pnpm exec tsc --noEmit --pretty false", "pnpm exec vitest run"],
  deny: ["pnpm install --frozen-lockfile --prefer-offline", "pnpm install --no-frozen-lockfile --prefer-offline"],
};

export const DEFAULT_SKILLS_DIR = fileURLToPath(new URL("../.claude/skills", import.meta.url));

/** USD per run. */
export const BUDGETS: Record<Phase, number> = {
  scoping: 3,
  design: 4,
  test_writing: 5,
  implementing: 8,
  reviewing: 3,
  browser_check: 5,
  pr: 1.5,
  decider: 1.5,
  retro: 0.5,
  planning: 4,
  conductor: 1.5,
};

const READ = ["Read", "Grep", "Glob", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git status:*)", "Bash(git show:*)"];
const WRITE_DOCS = ["Write(docs/designs/**)", "Edit(docs/designs/**)"];
/** Read, write, and run the project's own checks (each command and anything after it, such as a file path). */
function codeTools(tools: ToolRules): string[] {
  return [...READ, "Write", "Edit", ...tools.run.map((c) => `Bash(${c.trim()}:*)`)];
}

/** Tools no phase gets. A deny wins over an allow. */
const FIXED_DENY = [
  "AskUserQuestion",
  "Task",
  "Agent",
  "WebFetch",
  "WebSearch",
  "Bash(git commit:*)",
  "Bash(git push:*)",
  "Bash(git reset:*)",
  "Bash(git checkout:*)",
  "Bash(git switch:*)",
  "Bash(git rebase:*)",
  "Bash(git -C:*)",
  // The factory does every GitHub call itself, and reads GitHub issues for the agents.
  "Bash(gh:*)",
  // Adding packages is the factory's job (and a high-risk change), for every package manager.
  "Bash(pnpm add:*)",
  "Bash(pnpm install:*)",
  "Bash(npm install:*)",
  "Bash(npm i:*)",
  "Bash(npm ci:*)",
  "Bash(yarn add:*)",
  "Bash(yarn install:*)",
  "Bash(bun add:*)",
  "Bash(bun install:*)",
];

/** The fixed denies, plus the project's install and start commands. `npx` and friends are denied unless a check uses them. */
export function denyTools(tools: ToolRules = DEFAULT_TOOLS): string[] {
  const runners = ["npx", "bunx", "pnpm dlx", "yarn dlx"].filter((r) => !tools.run.some((c) => c.trim().startsWith(r)));
  return [...new Set([...FIXED_DENY, ...runners.map((r) => `Bash(${r}:*)`), ...tools.deny.map((c) => `Bash(${c.trim()}:*)`)])];
}

const str = { type: "string" } as const;
const strs = { type: "array", items: str } as const;
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });

export const SCHEMAS = {
  scoping: obj(
    { title: str, summary: str, solutionDoc: str, questions: strs, needsBrowser: { type: "boolean" }, ticketType: { enum: ["task", "fix"] } },
    ["title", "summary", "solutionDoc", "questions", "needsBrowser", "ticketType"],
  ),
  design: obj(
    {
      summary: str,
      tasksDoc: str,
      questions: strs,
      needsBrowser: { type: "boolean" },
      browserPath: str,
      browserPlan: { type: "array", items: obj({ criterion: str, path: str, steps: str }, ["criterion", "path", "steps"]) },
    },
    ["summary", "tasksDoc", "questions", "needsBrowser", "browserPath", "browserPlan"],
  ),
  test_writing: obj({ summary: str, testFiles: strs, noTestsReason: str, questions: strs }, ["summary", "testFiles", "questions"]),
  implementing: obj({ summary: str, questions: strs, followUps: strs, testFixes: strs }, ["summary", "questions", "followUps"]),
  reviewing: obj({ verdict: { enum: ["approve", "request_changes"] }, summary: str, blocking: strs }, ["verdict", "summary", "blocking"]),
  browser_check: obj(
    {
      summary: str,
      blocked: { type: "boolean" },
      criteria: {
        type: "array",
        items: obj({ criterion: str, pass: { type: "boolean" }, untestable: { type: "boolean" }, evidence: str, screenshots: strs }, [
          "criterion",
          "pass",
          "evidence",
          "screenshots",
        ]),
      },
    },
    ["summary", "blocked", "criteria"],
  ),
  pr: obj({ title: str, body: str }, ["title", "body"]),
  decider: obj(
    { summary: str, decisions: { type: "array", items: obj({ question: str, answer: str, needsHuman: { type: "boolean" } }, ["question", "answer", "needsHuman"]) } },
    ["summary", "decisions"],
  ),
} as const;

function slug(task: Task): string {
  // "#42" (a GitHub issue) gives issue-42; "PROJ-12" gives proj-12.
  const base = task.ticketKey ? task.ticketKey.replace(/^#/, "issue-") : task.title;
  return base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || task.id.slice(0, 8);
}

export const docPaths = (task: Task) => ({
  solution: `docs/designs/${slug(task)}-solution.md`,
  tasks: `docs/designs/${slug(task)}-tasks.md`,
});

function ticket(task: Task, ctx: PhaseContext): string {
  const t = task.context?.ticket;
  if (t) {
    const comments = t.comments.length ? `\n### Comments\n\n${t.comments.map((c) => `- ${c.replace(/\n/g, "\n  ")}`).join("\n")}\n` : "";
    return `## The ticket\n\nGitHub issue ${task.ticketKey} (${t.url}). Title: ${t.title}\n\n${t.body || "(no description)"}\n${comments}${task.description ? `\n### Notes from the person who added the task\n\n${task.description}\n` : ""}`;
  }
  const where = task.ticketKey && ctx.tracker ? `${ctx.tracker.label} ticket ${task.ticketKey}. ${ctx.tracker.instructions}\n` : "";
  return `## The ticket\n\n${where}Title: ${task.title}\n${task.description ? `\n${task.description}\n` : ""}`;
}

function feedbackBlock(feedback: string[]): string {
  if (feedback.length === 0) return "";
  return `\n## Feedback from the last attempt. Address every item\n\n${feedback.map((f) => `- ${f}`).join("\n")}\n`;
}

function lockedBlock(locked: string[]): string {
  if (locked.length === 0) return "";
  return `\n## Locked test files. Do not edit them\n\n${locked.map((f) => `- ${f}`).join("\n")}\n`;
}

/**
 * The phase skills each stage follows, relative to the skills folder. They ship with the factory, so the target
 * repository needs no copy; each run gets the folder with `--add-dir`. Several skills set
 * `disable-model-invocation`, so the prompt tells the agent to Read them rather than invoke them.
 * Precedence: headless rules > overrides > skill.
 */
export const PHASE_SKILLS: Record<AgentStage, string[]> = {
  scoping: ["to-spec/SKILL.md"],
  design: ["codebase-design/SKILL.md", "codebase-design/DEEPENING.md", "domain-modeling/SKILL.md"],
  test_writing: ["tdd/SKILL.md", "tdd/tests.md", "tdd/mocking.md"],
  implementing: ["implement/SKILL.md", "tdd/SKILL.md", "tdd/mocking.md"],
  reviewing: ["code-review/SKILL.md"],
  browser_check: [],
  pr: ["pr/SKILL.md"],
};

const skillsDir = (ctx: PhaseContext) => ctx.skillsDir ?? DEFAULT_SKILLS_DIR;

const TRACKER =
  "Where a skill mentions the issue tracker or `/setup-matt-pocock-skills`: the ticket is the one below. Do not write to the tracker or to GitHub; the factory does every write (issues, labels, comments, pull requests).";

function overrides(stage: AgentStage, task: Task, ctx: PhaseContext): string[] {
  const d = docPaths(task);
  const base = `origin/${ctx.baseBranch ?? "main"}`;
  switch (stage) {
    case "scoping":
      return [
        `Use the spec template for the solution doc: Problem Statement, Solution, User Stories, Implementation Decisions, Testing Decisions, Out of Scope, Further Notes. Write it to \`${d.solution}\`; do not publish it or apply labels.`,
        "Put the acceptance criteria in the doc as a numbered, testable list. The user stories can be as long as the change needs, not longer.",
        "Sketch the test seams in Testing Decisions. Do not check them with a user; the design phase settles them.",
        "If `GLOSSARY.md` exists, use its vocabulary and respect ADRs in `docs/adr/`. Do not create or edit either in this phase.",
        TRACKER,
      ];
    case "design":
      return [
        "Use the deep-module vocabulary (module, interface, seam, adapter, depth) in the task list, and name the seams the tests go at.",
        "Do not use DESIGN-IT-TWICE (no parallel sub-agents). Compare alternatives yourself when it matters, and record the choice in the task list.",
        "From domain-modeling, do not run a session with a user. Update `GLOSSARY.md` only for a term this change introduces or sharpens. Write an ADR in `docs/adr/` only when all three of its tests hold (hard to reverse, surprising, a real trade-off).",
        TRACKER,
      ];
    case "test_writing":
      return [
        `The seams are the ones in \`${d.tasks}\`. They are not confirmed with a user; if one is missing or wrong, ask in \`questions\`.`,
        "Write all the tests for the task list now, before any implementation. The factory's red check runs them; the implement phase does the green half. This replaces the one-test-at-a-time loop.",
        "Test behaviour at the highest seam through public interfaces, never implementation details, and never with tautological expected values.",
      ];
    case "implementing":
      return [
        `The "ticket" or spec is the task list \`${d.tasks}\` with the ticket below. It is already fetched; do not ask which ticket.`,
        "Do the green half of tdd: the locked tests are the red tests. Add tests of your own only at the seams the task list names.",
        "Do not commit. The factory commits after the checks.",
        "Do not run code-review at the end. A separate review phase does.",
        TRACKER,
      ];
    case "reviewing":
      return [
        `The fixed point is the merge base with \`${base}\`. The factory commits after review, so run \`git diff --merge-base ${base}\` (working tree against the merge base) rather than \`git diff ${base}...HEAD\`, which shows committed work only. Run \`git status --short\` and Read any untracked file, because new files do not show in \`git diff\`.`,
        "No sub-agents: review both axes yourself, Standards first and then Spec. The spec is the ticket below and the solution doc.",
        "Report in the output schema, not as a Standards/Spec report: a hard standards breach or a spec requirement that is missing or wrong is blocking, as `file:line` and the problem. Smells and style are not blocking; mention the worst in `summary`.",
        TRACKER,
      ];
    case "pr":
      return [
        "Write `body` with the template's sections: Summary (one small visual), Evidence, Merge Danger.",
        `Read the change with \`git diff --merge-base ${base}\` and \`git status --short\`. For Evidence use the tests the factory ran and any screenshots named in the feedback; do not run the app.`,
        "Do not add an attribution line; the factory adds its own footer.",
      ];
    default:
      return [];
  }
}

function howToWork(stage: AgentStage, task: Task, ctx: PhaseContext): string {
  const files = PHASE_SKILLS[stage].map((f) => join(skillsDir(ctx), f));
  if (files.length === 0) return "";
  const rules = overrides(stage, task, ctx);
  return `\n## How to work\n\nRead these files with the Read tool before you start and follow them, except where the overrides below say otherwise. Do not invoke them as slash commands.\n\n${files.map((f) => `- \`${f}\``).join("\n")}\n\nOverrides for this factory (the headless rules win over these, and these win over the skills):\n\n${rules.map((r) => `- ${r}`).join("\n")}\n`;
}

const PROMPTS: Record<AgentStage, (task: Task, ctx: PhaseContext) => string> = {
  scoping: (task, ctx) => {
    const d = docPaths(task);
    return `# Phase: scoping\n\nTurn the ticket into a solution doc with testable acceptance criteria. Write it to \`${d.solution}\`. The factory already checked that no open pull request or commit on the base branch covers this ticket.\n\nIf the ticket leaves something open that the code and the repository docs do not settle, list it in \`questions\`. Set \`needsBrowser\` when the change has a visible effect in the app. Do not propose ticket changes; put suggested wording in the solution doc.\n\n${ticket(task, ctx)}`;
  },
  design: (task, ctx) => {
    const d = docPaths(task);
    return `# Phase: design\n\nRead the solution doc \`${d.solution}\`. Decide how to build it and write the task list to \`${d.tasks}\`: files to change, types, the tests to write.\n\nIf the change is visible, write a browser plan: one entry per acceptance criterion, with the page path and the steps to reach the state to check. Use pages and data that exist in the local app.\n\n${ticket(task, ctx)}`;
  },
  test_writing: (task, ctx) => {
    const d = docPaths(task);
    return `# Phase: test writing\n\nRead \`${d.tasks}\`. Write tests that fail now and pass once the change is made. Do not change production code. Return the test file paths from the repository root.\n\nThe factory type-checks your tests (errors for code that does not exist yet are allowed), runs them to confirm they fail, then locks them. If no useful unit test exists for this change, return no files and say why in \`noTestsReason\`.\n\n${ticket(task, ctx)}`;
  },
  implementing: (task, ctx) => {
    const d = docPaths(task);
    return `# Phase: implement\n\nMake the locked tests pass and finish the task list in \`${d.tasks}\`. Run the tests, the type checker and the linter yourself as you go; the factory runs them again afterwards against the merge base.\n\nIf a locked test is wrong in a way no correct implementation can pass, describe each problem in \`testFixes\` and stop. List work for a later ticket in \`followUps\`.\n\n${ticket(task, ctx)}`;
  },
  reviewing: (task, ctx) =>
    `# Phase: review\n\nYou can only read. Review the change against the base branch at its merge base (see How to work). Check correctness, integration risk and simplicity against the ticket and \`${docPaths(task).solution}\`.\n\nReturn \`approve\` with no blocking items, or \`request_changes\` with each blocking item as \`file:line\` and the problem. Style preferences are not blocking.\n\n${ticket(task, ctx)}`,
  browser_check: (task, ctx) => {
    const plan = ctx.browserPlan.map((p, i) => `${i + 1}. ${p.criterion}\n   Page: ${p.path}\n   Steps: ${p.steps}`).join("\n");
    return `# Phase: browser check\n\nThe app runs at ${ctx.browserUrl}. Check each acceptance criterion in the browser, following the plan. Explore only when a step fails.\n\nTake one screenshot per criterion and return its file name. Mark a criterion \`untestable\` when the local app lacks the role or data it needs, and name the test that covers it. Set \`blocked\` only when the app does not load or sign-in fails.\n\n## Plan\n\n${plan || "No plan: check the acceptance criteria in the solution doc."}\n\n${ticket(task, ctx)}`;
  },
  pr: (task, ctx) =>
    `# Phase: pull request text\n\nWrite the pull request title and body for the change on this branch (read it against the merge base, see How to work). Explain what changed and why, and how it was checked. Do not add an attribution line; the factory adds its own footer.\n\n${ticket(task, ctx)}`,
};

function stageTools(stage: AgentStage, tools: ToolRules): string[] {
  switch (stage) {
    case "scoping":
    case "design":
      return [...READ, ...WRITE_DOCS];
    case "test_writing":
    case "implementing":
      return codeTools(tools);
    case "browser_check":
      return [...READ, "mcp__playwright"];
    default:
      return READ;
  }
}

export function phaseCall(stage: AgentStage, task: Task, ctx: PhaseContext): ClaudeCall {
  const prompt =
    PROMPTS[stage](task, ctx) +
    (ctx.verify ? verifyRules(stage, ctx.verify) : "") +
    howToWork(stage, task, ctx) +
    lockedBlock(stage === "implementing" ? ctx.lockedFiles : []) +
    feedbackBlock(ctx.feedback);
  const tracker = trackerAccess(ctx);
  return {
    prompt,
    allowedTools: [...stageTools(stage, ctx.tools ?? DEFAULT_TOOLS), ...tracker.tools],
    disallowedTools: denyTools(ctx.tools),
    addDirs: PHASE_SKILLS[stage].length > 0 ? [skillsDir(ctx)] : [],
    mcpServers: { ...tracker.servers, ...(stage === "browser_check" && ctx.browserMcp ? { playwright: ctx.browserMcp } : {}) },
    outputSchema: SCHEMAS[stage],
    maxBudgetUsd: BUDGETS[stage],
    settings: mergeSettings(ctx.isolation && isolationSettings(ctx.isolation), verifyDenies(ctx.verify), stage === "implementing" ? ctx.settings : undefined),
    model: ctx.model,
  };
}

/**
 * The decider answers another phase's questions. Read-only. It sets `needsHuman` only when nothing
 * in the ticket, the code or the repo rules settles a question and a wrong answer would be costly to undo.
 */
export function deciderCall(task: Task, ctx: PhaseContext, stage: AgentStage, questions: string[], summary: string): ClaudeCall {
  const prompt = `# Phase: decider\n\nThe ${stage} phase stopped with questions. Answer each one so the work can continue without a person.\n\nRead the ticket, the solution doc (\`${docPaths(task).solution}\`, if it exists), the repository's docs and instructions files, and the existing code. Prefer the smallest change that meets the acceptance criteria. Give each answer with its reason.\n\nSet \`needsHuman\` only when nothing in the ticket, the code or the repository rules settles the question AND a wrong answer would cost more than one review round to undo: money, legal text, security, stored data.\n\n## The ${stage} phase's summary\n\n${summary || "(none)"}\n\n## Questions\n\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n\n${ticket(task, ctx)}`;
  const tracker = trackerAccess(ctx);
  return {
    prompt,
    allowedTools: [...READ, ...tracker.tools],
    disallowedTools: denyTools(ctx.tools),
    mcpServers: tracker.servers,
    settings: ctx.isolation && isolationSettings(ctx.isolation),
    outputSchema: SCHEMAS.decider,
    maxBudgetUsd: BUDGETS.decider,
    model: ctx.model,
  };
}

/** Claude Code settings with a PreToolUse hook that refuses edits to the files listed in `lockedListFile`. */
export function lockedFilesSettings(lockedListFile: string, guardScript: string): object {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "Write|Edit|MultiEdit|NotebookEdit",
          hooks: [{ type: "command", command: `node ${JSON.stringify(guardScript)} ${JSON.stringify(lockedListFile)}` }],
        },
      ],
    },
  };
}
