/**
 * The retro: after a task ends (done, or escalated), a short read-only run looks at what happened and proposes at
 * most three learnings. A person approves, edits or rejects each one; nothing reaches a prompt until then.
 */
import type { LearningKind, TaskDetail } from "../shared/api";
import type { ClaudeCall } from "./claude";
import { BUDGETS, denyTools, type PhaseContext, isolationSettings } from "./phases";

const str = { type: "string" } as const;

export const RETRO_SCHEMA = {
  type: "object",
  properties: {
    summary: str,
    learnings: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          kind: { enum: ["factory", "codebase"] },
          summary: str,
          target: str,
          evidence: { type: "array", items: str },
        },
        required: ["kind", "summary", "target", "evidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "learnings"],
  additionalProperties: false,
} as const;

export type RetroOutput = { summary: string; learnings: Array<{ kind: LearningKind; summary: string; target: string; evidence: string[] }> };

const clip = (text: string | null | undefined, n: number) => {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}...` : t;
};

/** What happened in the task, in a form a short run can read: stages, runs, failures, decisions, people's feedback. */
export function retroDigest(detail: TaskDetail): string {
  const { task, agentRuns, events, feedback } = detail;
  const c = task.context;
  const moves = events.filter((e) => e.type === "status_changed").map((e) => `${e.ts} ${String(e.payload.from)} -> ${String(e.payload.to)}`);
  const runs = [...agentRuns]
    .reverse()
    .map((r) => `- ${r.stage}/${r.kind} ${r.status}${r.costUsd ? `, $${r.costUsd.toFixed(2)}` : ""}${r.model ? `, ${r.model}` : ""}: ${clip(r.summary, 400)}`);
  const people = feedback.map((f) => `- ${f.decision}${f.comment ? `: ${clip(f.comment, 400)}` : ""}`);
  const decisions = (c.decisions ?? []).map((d) => `- ${d.stage}: ${clip(d.question, 200)} -> ${clip(d.answer, 200)}`);
  return [
    `Task: ${task.ticketKey ? `${task.ticketKey} ` : ""}${task.title}`,
    `Status: ${task.status}${c.escalation ? `. Escalated: ${clip(c.escalation, 600)}` : ""}`,
    `Cost: $${task.costUsd.toFixed(2)}. Failed attempts in the last round: ${task.attempts}.`,
    "",
    "## Stages",
    ...moves,
    "",
    "## Runs, oldest first",
    ...runs,
    ...(decisions.length ? ["", "## Decisions the decider made", ...decisions] : []),
    ...(people.length ? ["", "## Feedback from people", ...people] : []),
    ...(c.untested?.length ? ["", "## Criteria not checked in the browser", ...c.untested.map((u) => `- ${u.criterion}: ${u.reason}`)] : []),
  ].join("\n");
}

export function retroCall(detail: TaskDetail, ctx: PhaseContext): ClaudeCall {
  const prompt = `# Phase: retro

The task below has ended. Find what would have made it cheaper or more correct, and propose at most three learnings. Propose fewer, or none, when nothing is worth a rule: a learning must have prevented a failed attempt, an escalation, a wasted run or a person's correction in this task, and must apply to later tasks too.

Each learning is one of:
- "factory": a rule for how the factory's agents work in this repository (for example "run the app's tests with pnpm test, not jest directly"). Approved ones go into the instructions every later run reads.
- "codebase": a rule about this codebase that belongs in its own instructions file, so people and agents both follow it. Set \`target\` to that file, usually CLAUDE.md or AGENTS.md (look for one in the repository). For a factory learning, set \`target\` to "".

Write each summary as an instruction, in one or two short sentences, in plain words. Do not repeat a rule that is already in the repository's instructions. In \`evidence\`, quote what happened in this task that shows the problem: the run, the failure or the comment.

You can read the repository (the task's worktree) to check a rule before you propose it. Do not change any file.

${retroDigest(detail)}`;
  return {
    prompt,
    allowedTools: ["Read", "Grep", "Glob", "Bash(git log:*)", "Bash(git diff:*)", "Bash(git show:*)"],
    disallowedTools: [...denyTools(ctx.tools), "Write", "Edit"],
    mcpServers: {},
    settings: ctx.isolation && isolationSettings(ctx.isolation),
    outputSchema: RETRO_SCHEMA,
    maxBudgetUsd: BUDGETS.retro,
    model: ctx.model,
  };
}
