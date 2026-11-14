import { useState, type FormEvent } from "react";
import type { CreateTaskInput } from "../../../shared/api";
import { verifyAttrs } from "../../verify/core/contract";

export interface NewTaskFormProps {
  onCreate: (input: CreateTaskInput) => Promise<void> | void;
  /** Error from the last create attempt, e.g. the API rejected it. */
  error?: string | null;
}

/** "12", "#12" or " 12 " → "#12". Anything else → null. */
export function parseIssue(text: string): string | null {
  const m = /^#?(\d+)$/.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? `#${n}` : null;
}

/** "5, #6 5" → ["#5", "#6"] (deduplicated, in order). Empty → []. Any invalid entry → null. */
export function parseBlockers(text: string): string[] | null {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  const keys: string[] = [];
  for (const part of parts) {
    const key = parseIssue(part);
    if (!key) return null;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** Give the factory a GitHub issue. The scoping agent reads the issue for the title and details. */
export function NewTaskForm({ onCreate, error }: NewTaskFormProps) {
  const [issue, setIssue] = useState("");
  const [blockers, setBlockers] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const ticketKey = parseIssue(issue);
  const blockedBy = parseBlockers(blockers);
  const issueError = issue.trim() !== "" && !ticketKey ? "Enter an issue number, like 12 or #12." : null;
  const blockersError =
    blockedBy === null ? "Blocked by takes issue numbers only, like 5, 6." : ticketKey && blockedBy.includes(ticketKey) ? `${ticketKey} can't block itself.` : null;
  const canSubmit = ticketKey !== null && blockedBy !== null && !blockersError && !submitting;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || !ticketKey || !blockedBy) return;
    setSubmitting(true);
    try {
      await onCreate({ ticketKey, blockedBy });
      setIssue("");
      setBlockers("");
    } catch {
      // The parent surfaces the error via the `error` prop; keep the user's input.
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="new-task"
      onSubmit={submit}
      {...verifyAttrs({
        unit: "NewTaskForm",
        "can-submit": canSubmit,
        submitting,
        "has-error": Boolean(error),
        issue: ticketKey ?? "",
        "blocked-by": blockedBy?.join(" ") ?? "",
        invalid: Boolean(issueError || blockersError),
      })}
    >
      <h2>New task</h2>
      <label htmlFor="task-issue">GitHub issue</label>
      <input
        id="task-issue"
        type="text"
        inputMode="numeric"
        value={issue}
        onChange={(e) => setIssue(e.target.value)}
        placeholder="e.g. 12"
        aria-invalid={issueError ? true : undefined}
        aria-describedby={issueError ? "task-issue-error" : undefined}
      />
      {issueError && (
        <p id="task-issue-error" className="field-error">
          {issueError}
        </p>
      )}
      <label htmlFor="task-blocked-by">Blocked by (optional)</label>
      <input
        id="task-blocked-by"
        type="text"
        value={blockers}
        onChange={(e) => setBlockers(e.target.value)}
        placeholder="e.g. 5, 6"
        aria-invalid={blockersError ? true : undefined}
        aria-describedby={blockersError ? "task-blocked-by-error" : undefined}
      />
      {blockersError && (
        <p id="task-blocked-by-error" className="field-error">
          {blockersError}
        </p>
      )}
      <p className="hint">The factory reads the title and details from the issue.</p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button type="submit" disabled={!canSubmit}>
        {submitting ? "Adding…" : "Add task"}
      </button>
    </form>
  );
}
