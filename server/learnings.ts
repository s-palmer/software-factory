/**
 * Applying approved learnings. A factory learning is added to the repository's learnings file, which every later
 * agent run reads. A codebase learning becomes a factory task that adds the rule to the repository's own
 * instructions file, so it reaches the code through a pull request, like any other change.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Learning } from "../shared/api";
import type { FactoryDb } from "./db";

export type ApplyResult = { factory: number; tasks: Array<{ learningId: string; taskId: string }> };

export async function applyLearnings(db: FactoryDb, learningsFile: string, by = "human"): Promise<ApplyResult> {
  const result: ApplyResult = { factory: 0, tasks: [] };
  const pending = (await db.listLearnings()).filter((l) => l.status === "approved" && !l.appliedAt);
  for (const l of [...pending].reverse()) {
    if (l.kind === "factory") {
      mkdirSync(dirname(learningsFile), { recursive: true });
      const before = existsSync(learningsFile) ? readFileSync(learningsFile, "utf8") : "";
      appendFileSync(learningsFile, `${before && !before.endsWith("\n") ? "\n" : ""}- ${oneLine(l.summary)}\n`);
      await db.markLearningApplied(l.id, "learnings file");
      result.factory++;
    } else {
      const task = await db.createTask(codebaseTask(l), "backlog", by);
      await db.markLearningApplied(l.id, `task:${task.id}`);
      result.tasks.push({ learningId: l.id, taskId: task.id });
    }
  }
  return result;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

function codebaseTask(l: Learning): { title: string; description: string } {
  const target = l.target ?? "CLAUDE.md";
  const summary = oneLine(l.summary);
  return {
    title: `Add to ${target}: ${summary.length > 80 ? `${summary.slice(0, 77)}...` : summary}`,
    description: [
      `Add this rule to \`${target}\` (create the file if the repository has none), in the section where it fits, and keep the file's style. Change nothing else.`,
      "",
      `Rule: ${summary}`,
      ...(l.evidence.length ? ["", "Why (from an earlier task):", ...l.evidence.map((e) => `- ${e}`)] : []),
    ].join("\n"),
  };
}
