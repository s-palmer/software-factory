import { createElement } from "react";
import { z } from "zod";
import type { CreateTaskInput } from "../../../shared/api";
import { NewTaskForm, type NewTaskFormProps } from "../../dashboard/components/NewTaskForm";
import type { ActContext } from "../core/types";
import { registerUnit } from "../core/registry";

/** Records what the form submitted, so invariants can check it. */
const created: CreateTaskInput[] = [];
const record: NewTaskFormProps["onCreate"] = (input) => {
  created.push(input);
};

const fill = async (ctx: ActContext, issue: string, blockers = "") => {
  await ctx.type("#task-issue", issue);
  if (blockers) await ctx.type("#task-blocked-by", blockers);
  await ctx.click("button[type=submit]");
};

/** The fixtures that submit valid input, and exactly what each must send. */
const EXPECTED: Record<string, CreateTaskInput> = {
  submit: { ticketKey: "#12", blockedBy: [] },
  "hash-form": { ticketKey: "#12", blockedBy: [] },
  "padded-form": { ticketKey: "#12", blockedBy: [] },
  "with-blockers": { ticketKey: "#12", blockedBy: ["#5", "#6"] },
  "jira-key": { ticketKey: "PROJ-12483", blockedBy: ["PROJ-1"] },
};

const jira = { type: "mcp", label: "Jira", keyPattern: "^[A-Z][A-Z0-9]+-\\d+$" } as const;

registerUnit<NewTaskFormProps>({
  id: "NewTaskForm",
  title: "NewTaskForm",
  description: "Give the factory a ticket (a GitHub issue number, or a Jira or Linear key), optionally blocked by others. No title: the agents read it from the ticket.",
  kind: "component",
  render: (props) => {
    created.length = 0;
    return createElement(NewTaskForm, props);
  },
  propsSchema: z.object({
    onCreate: z.function(),
    error: z.string().nullish(),
    tracker: z.union([z.object({ type: z.literal("github") }), z.object({ type: z.literal("mcp"), label: z.string(), keyPattern: z.string().nullable() })]).optional(),
  }),
  fixtures: [
    { id: "empty", description: "Nothing typed; Add is disabled and no error is shown.", props: { onCreate: record } },
    { id: "submit", description: "Type 12 and submit; it is sent as #12 and the form clears.", props: { onCreate: record }, act: (ctx) => fill(ctx, "12") },
    { id: "hash-form", probe: true, description: "Probe: '#12' normalises to the same key as '12'.", props: { onCreate: record }, act: (ctx) => fill(ctx, "#12") },
    { id: "padded-form", probe: true, description: "Probe: ' 12 ' normalises to the same key as '12'.", props: { onCreate: record }, act: (ctx) => fill(ctx, " 12 ") },
    {
      id: "with-blockers",
      probe: true,
      description: "Probe: blockers with commas, spaces, '#' and a duplicate become ['#5', '#6'].",
      props: { onCreate: record },
      act: (ctx) => fill(ctx, "12", " 5, #6 ,5  6"),
    },
    { id: "not-a-number", probe: true, description: "Probe: 'abc' is rejected with an error and can't be submitted.", props: { onCreate: record }, act: (ctx) => fill(ctx, "abc") },
    { id: "zero", probe: true, description: "Probe: issue 0 doesn't exist.", props: { onCreate: record }, act: (ctx) => fill(ctx, "0") },
    { id: "bad-blocker", probe: true, description: "Probe: a non-number blocker is rejected.", props: { onCreate: record }, act: (ctx) => fill(ctx, "12", "5, abc") },
    { id: "self-blocker", probe: true, description: "Probe: an issue can't block itself.", props: { onCreate: record }, act: (ctx) => fill(ctx, "#12", "12") },
    { id: "jira-key", description: "Jira: a key in lower case is sent upper case, with its blocker.", props: { onCreate: record, tracker: jira }, act: (ctx) => fill(ctx, "proj-12483", "PROJ-1") },
    { id: "jira-not-a-key", probe: true, description: "Probe: Jira does not take a GitHub issue number.", props: { onCreate: record, tracker: jira }, act: (ctx) => fill(ctx, "#12") },
    { id: "server-error", probe: true, description: "Probe: an API error is shown as an alert.", props: { onCreate: record, error: "Ticket #12 already has task 3f2a" } },
  ],
  invariants: [
    {
      id: "submit-disabled-iff-cannot-submit",
      description: "Add button is disabled if and only if the form can't submit",
      check: ({ root, contract }) => {
        const btn = root.querySelector<HTMLButtonElement>("button[type=submit]");
        return btn?.disabled === (contract["can-submit"] !== "true") || `disabled=${btn?.disabled} can-submit=${contract["can-submit"]}`;
      },
    },
    {
      id: "sends-normalised-and-clears",
      description: "A valid submit sends exactly { ticketKey: '#N', blockedBy: [...] } once (no title) and clears both fields",
      onlyFixtures: Object.keys(EXPECTED),
      check: ({ root, fixture }) => {
        const issue = root.querySelector<HTMLInputElement>("#task-issue")?.value;
        const blockers = root.querySelector<HTMLInputElement>("#task-blocked-by")?.value;
        return (JSON.stringify(created) === JSON.stringify([EXPECTED[fixture.id]]) && issue === "" && blockers === "") ||
          `created=${JSON.stringify(created)} issue="${issue}" blockers="${blockers}"`;
      },
    },
    {
      id: "invalid-not-sent",
      description: "Invalid input shows a field error, marks the input invalid, disables Add and sends nothing",
      onlyFixtures: ["not-a-number", "zero", "bad-blocker", "self-blocker", "jira-not-a-key"],
      check: ({ root, contract }) => {
        const errors = root.querySelectorAll(".field-error").length;
        const invalidInputs = root.querySelectorAll('[aria-invalid="true"]').length;
        const disabled = root.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled;
        return (created.length === 0 && errors === 1 && invalidInputs === 1 && disabled === true && contract.invalid === "true") ||
          `created=${JSON.stringify(created)} errors=${errors} invalid=${invalidInputs} disabled=${disabled}`;
      },
    },
    {
      id: "no-field-error-when-valid-or-empty",
      description: "No field error for empty or valid input",
      onlyFixtures: ["empty", ...Object.keys(EXPECTED), "server-error"],
      check: ({ root, contract }) => (root.querySelector(".field-error") === null && contract.invalid === "false") || "unexpected field error",
    },
    {
      id: "only-issue-fields",
      description: "The form asks only for the issue and its blockers: no title or details fields",
      check: ({ root }) => {
        const fields = Array.from(root.querySelectorAll("input, textarea, select")).map((el) => el.id);
        return fields.join() === "task-issue,task-blocked-by" || `fields=${fields.join()}`;
      },
    },
    {
      id: "names-the-tracker",
      description: "The field is labelled with the tracker: GitHub issue, or the tracker's ticket",
      check: ({ root, props }) => {
        const label = root.querySelector('label[for="task-issue"]')?.textContent;
        const want = !props.tracker || props.tracker.type === "github" ? "GitHub issue" : `${props.tracker.label} ticket`;
        return label === want || `label="${label}"`;
      },
    },
    {
      id: "error-shown-iff-error",
      description: "An alert is shown if and only if there's an error",
      check: ({ root, props }) => (root.querySelector("[role=alert]")?.textContent ?? null) === (props.error ?? null),
    },
  ],
});
