import { createElement } from "react";
import { z } from "zod";
import type { Learning, UpdateLearningInput } from "../../../shared/api";
import { LearningList, type LearningListProps } from "../../dashboard/components/LearningList";
import { registerUnit } from "../core/registry";

const saved: Array<{ id: string; change: UpdateLearningInput }> = [];
let applied = 0;
const onSave = (id: string, change: UpdateLearningInput) => void saved.push({ id, change });
const onApply = () => void applied++;

const learning = (id: string, extra: Partial<Learning> = {}): Learning => ({
  id,
  sourceTaskId: "t1",
  source: "retro",
  kind: "factory",
  summary: "Run the app's tests with pnpm test, not jest directly.",
  target: null,
  evidence: ["implementing: jest was denied in the sandbox, so no test ran"],
  status: "open",
  appliedTo: null,
  appliedAt: null,
  createdAt: "2026-11-14T15:00:00",
  ...extra,
});

const mixed = [
  learning("p1"),
  learning("p2", { kind: "codebase", target: "AGENTS.md", summary: "Dropdowns mark the selected option with a background colour, not bold text." }),
  learning("a1", { status: "approved", summary: "Read the design doc before the tests." }),
  learning("d1", { status: "approved", appliedTo: "task:t9", appliedAt: "2026-11-14T15:10:00", kind: "codebase", target: "CLAUDE.md", summary: "Use the shared Dropdown." }),
  learning("d2", { status: "approved", appliedTo: "learnings file", appliedAt: "2026-11-14T15:10:00", summary: "Keep the browser check to the plan." }),
  learning("r1", { status: "rejected", summary: "Too specific." }),
];

registerUnit<LearningListProps>({
  id: "LearningList",
  title: "LearningList",
  description: "The retro's learnings: proposed ones to edit, approve or reject; approved ones to apply; applied ones with where they went.",
  kind: "component",
  render: (props) => {
    saved.length = 0;
    applied = 0;
    return createElement(LearningList, props);
  },
  propsSchema: z.object({ learnings: z.array(z.custom<Learning>()), onSave: z.function(), onApply: z.function(), busy: z.boolean().optional(), message: z.object({ ok: z.boolean(), text: z.string() }).nullish() }),
  fixtures: [
    { id: "mixed", description: "Two proposed, one approved, two applied, one rejected.", props: { learnings: mixed, onSave, onApply } },
    {
      id: "approve-edited",
      description: "Edit a proposal's text, then approve it: the edited text is sent with the approval.",
      props: { learnings: mixed, onSave, onApply },
      act: async (ctx) => {
        await ctx.type("#learning-summary-p1", "Run the tests with pnpm test.");
        await ctx.click('[data-learning-id="p1"] .learnings__approve');
      },
    },
    { id: "reject", description: "Reject a proposal.", props: { learnings: mixed, onSave, onApply }, act: (ctx) => ctx.click('[data-learning-id="p2"] .learnings__reject') },
    { id: "apply", description: "Apply the approved learnings.", props: { learnings: mixed, onSave, onApply }, act: (ctx) => ctx.click(".learnings__apply") },
    {
      id: "make-codebase",
      probe: true,
      description: "Probe: turning a factory proposal into a codebase one asks for the file, and sends it.",
      props: { learnings: [learning("p1")], onSave, onApply },
      act: async (ctx) => {
        await ctx.select("#learning-kind-p1", "codebase");
        await ctx.click('[data-learning-id="p1"] .learnings__approve');
      },
    },
    { id: "empty", probe: true, description: "Probe: no learnings yet; Apply is disabled.", props: { learnings: [], onSave, onApply } },
    { id: "busy", probe: true, description: "Probe: while an action runs, every button is disabled.", props: { learnings: mixed, onSave, onApply, busy: true } },
    { id: "error", probe: true, description: "Probe: a refused action shows an alert.", props: { learnings: mixed, onSave, onApply, message: { ok: false, text: "agent:pm may not change learnings; only a person can" } } },
  ],
  invariants: [
    {
      id: "sections-match",
      description: "Proposed, approved and applied learnings each sit in their own list",
      check: ({ contract, props }) => {
        const want = {
          proposed: props.learnings.filter((l) => l.status === "open" && !l.appliedAt).length,
          approved: props.learnings.filter((l) => l.status === "approved" && !l.appliedAt).length,
          applied: props.learnings.filter((l) => l.appliedAt).length,
        };
        return (contract.proposed === String(want.proposed) && contract.approved === String(want.approved) && contract.applied === String(want.applied)) || `contract=${JSON.stringify(contract)}`;
      },
    },
    {
      id: "apply-enabled-iff-approved",
      description: "Apply is enabled only when something is approved and nothing is running",
      check: ({ root, props }) => {
        const btn = root.querySelector<HTMLButtonElement>(".learnings__apply");
        const want = props.learnings.some((l) => l.status === "approved" && !l.appliedAt) && !props.busy;
        return btn?.disabled === !want || `disabled=${btn?.disabled}`;
      },
    },
    {
      id: "applied-task-linked",
      description: "A codebase learning applied as a task links to that task",
      onlyFixtures: ["mixed"],
      check: ({ root }) => root.querySelector('[data-learning-id="d1"] a')?.getAttribute("href") === "/tasks/t9" || "no task link",
    },
    {
      id: "approve-sends-edit",
      description: "Approve sends the edited text with status approved",
      onlyFixtures: ["approve-edited"],
      check: () => (saved.length === 1 && saved[0]!.id === "p1" && saved[0]!.change.status === "approved" && saved[0]!.change.summary === "Run the tests with pnpm test.") || `saved=${JSON.stringify(saved)}`,
    },
    { id: "reject-sent", description: "Reject sends status rejected", onlyFixtures: ["reject"], check: () => (saved.length === 1 && saved[0]!.change.status === "rejected") || `saved=${JSON.stringify(saved)}` },
    { id: "apply-sent", description: "Apply asks once", onlyFixtures: ["apply"], check: () => applied === 1 || `applied=${applied}` },
    {
      id: "codebase-target",
      description: "A codebase learning is sent with its file",
      onlyFixtures: ["make-codebase"],
      check: () => (saved[0]?.change.kind === "codebase" && saved[0].change.target === "CLAUDE.md") || `saved=${JSON.stringify(saved)}`,
    },
    {
      id: "busy-disables",
      description: "While busy, every action button is disabled",
      onlyFixtures: ["busy"],
      check: ({ root }) => [...root.querySelectorAll("button")].every((b) => b.disabled) || "a button is enabled",
    },
    { id: "alert-iff-error", description: "An alert shows if and only if the last action failed", check: ({ root, props }) => Boolean(root.querySelector("[role=alert]")) === (props.message?.ok === false) || "alert mismatch" },
  ],
});
