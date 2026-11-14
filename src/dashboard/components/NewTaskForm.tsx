import { useState, type FormEvent } from "react";
import type { CreateTaskInput, TrackerInfo } from "../../../shared/api";
import type { Gate } from "../../../shared/lifecycle";
import { verifyAttrs } from "../../verify/core/contract";

export interface NewTaskFormProps {
  onCreate: (input: CreateTaskInput) => Promise<void> | void;
  /** The error from the last attempt to create a task, such as the API's refusal. */
  error?: string | null;
  /** Where tickets live. Default: GitHub issues. */
  tracker?: TrackerInfo;
}

const GITHUB: TrackerInfo = { type: "github" };

/** How much a person signs off. Autonomous is the default: the factory runs from ticket to pull request on its own. */
export const SIGN_OFF: ReadonlyArray<{ id: string; label: string; gates: Gate[] }> = [
  { id: "none", label: "Autonomous", gates: [] },
  { id: "scoping", label: "Sign off the solution", gates: ["scoping"] },
  { id: "design", label: "Sign off the task list", gates: ["design"] },
  { id: "both", label: "Sign off both", gates: ["scoping", "design"] },
];

/** "12", "#12" or " 12 " → "#12". Anything else → null. */
export function parseIssue(text: string): string | null {
  const m = /^#?(\d+)$/.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? `#${n}` : null;
}

/** A ticket key in the tracker's form: "#12" for GitHub; for Jira or Linear, upper case and matching the key pattern. */
export function parseKey(text: string, tracker: TrackerInfo = GITHUB): string | null {
  if (tracker.type === "github") return parseIssue(text);
  const key = text.trim().toUpperCase();
  if (!key || /\s/.test(key)) return null;
  return !tracker.keyPattern || new RegExp(tracker.keyPattern).test(key) ? key : null;
}

/** "5, #6 5" → ["#5", "#6"] (deduplicated, in order). Empty → []. Any invalid entry → null. */
export function parseBlockers(text: string, tracker: TrackerInfo = GITHUB): string[] | null {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  const keys: string[] = [];
  for (const part of parts) {
    const key = parseKey(part, tracker);
    if (!key) return null;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** Give the factory a ticket (a GitHub issue, or a Jira or Linear key). The agents read its title and details. */
export function NewTaskForm({ onCreate, error, tracker = GITHUB }: NewTaskFormProps) {
  const github = tracker.type === "github";
  const noun = github ? "issue" : "ticket";
  const example = github ? "12" : "PROJ-12";
  const [issue, setIssue] = useState("");
  const [blockers, setBlockers] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [signOff, setSignOff] = useState("none");

  const ticketKey = parseKey(issue, tracker);
  const blockedBy = parseBlockers(blockers, tracker);
  const issueError = issue.trim() !== "" && !ticketKey ? (github ? "Enter an issue number, like 12 or #12." : `Enter a ${tracker.label} key, like ${example}.`) : null;
  const blockersError =
    blockedBy === null ? (github ? "Blocked by takes issue numbers only, like 5, 6." : `Blocked by takes ${tracker.label} keys only, like PROJ-5, PROJ-6.`) : ticketKey && blockedBy.includes(ticketKey) ? `${ticketKey} can't block itself.` : null;
  const canSubmit = ticketKey !== null && blockedBy !== null && !blockersError && !submitting;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || !ticketKey || !blockedBy) return;
    setSubmitting(true);
    try {
      await onCreate({ ticketKey, blockedBy, gates: SIGN_OFF.find((s) => s.id === signOff)?.gates ?? [] });
      setIssue("");
      setBlockers("");
      setSignOff("none");
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
        tracker: github ? "github" : tracker.label,
        "can-submit": canSubmit,
        submitting,
        "has-error": Boolean(error),
        issue: ticketKey ?? "",
        "blocked-by": blockedBy?.join(" ") ?? "",
        invalid: Boolean(issueError || blockersError),
        "sign-off": signOff,
      })}
    >
      <h2>New task</h2>
      <label htmlFor="task-issue">{github ? "GitHub issue" : `${tracker.label} ticket`}</label>
      <input
        id="task-issue"
        type="text"
        inputMode={github ? "numeric" : "text"}
        value={issue}
        onChange={(e) => setIssue(e.target.value)}
        placeholder={`such as ${example}`}
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
        placeholder={github ? "such as 5, 6" : "such as PROJ-5, PROJ-6"}
        aria-invalid={blockersError ? true : undefined}
        aria-describedby={blockersError ? "task-blocked-by-error" : undefined}
      />
      {blockersError && (
        <p id="task-blocked-by-error" className="field-error">
          {blockersError}
        </p>
      )}
      <fieldset className="sign-off">
        <legend>Sign-off</legend>
        {SIGN_OFF.map((s) => (
          <label key={s.id} className="sign-off__option">
            <input type="radio" name="task-sign-off" id={`sign-off-${s.id}`} value={s.id} checked={signOff === s.id} onChange={() => setSignOff(s.id)} />
            {s.label}
          </label>
        ))}
      </fieldset>
      <p className="hint">The factory reads the title and details from the {noun}. With a sign-off, the task stops for your approval after that stage.</p>
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
