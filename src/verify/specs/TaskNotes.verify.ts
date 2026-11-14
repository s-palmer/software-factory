import { createElement } from "react";
import { z } from "zod";
import { TaskNotes, type TaskNotesProps } from "../../dashboard/components/TaskNotes";
import { registerUnit } from "../core/registry";

const decisions = [
  { stage: "scoping", question: "Should the empty state link to the new-task form?", answer: "Yes: it is the only useful next step." },
  { stage: "design", question: "One component or two?", answer: "One, with a compact prop, as PipelineProgress does." },
];

registerUnit<TaskNotesProps>({
  id: "TaskNotes",
  title: "TaskNotes",
  description: "The decider's answers to the agents' questions, and the reasons a change is high risk.",
  kind: "component",
  render: (props) => createElement(TaskNotes, props),
  propsSchema: z.object({
    context: z.object({
      decisions: z.array(z.object({ stage: z.string(), question: z.string(), answer: z.string() })).optional(),
      risk: z.object({ level: z.enum(["low", "high"]), reasons: z.array(z.string()) }).optional(),
    }),
  }),
  fixtures: [
    { id: "decisions-and-high-risk", description: "Two decisions, and high risk with reasons.", props: { context: { decisions, risk: { level: "high", reasons: ["Touches authentication", "Deletes a test"] } } } },
    { id: "decisions-low-risk", description: "Decisions only: low risk shows no risk box.", props: { context: { decisions, risk: { level: "low", reasons: ["Small diff"] } } } },
    { id: "nothing", probe: true, description: "Probe: no decisions and no risk hides the section.", props: { context: {} } },
    { id: "high-risk-no-reasons", probe: true, description: "Probe: high risk without reasons still says it is high risk.", props: { context: { risk: { level: "high", reasons: [] } } } },
  ],
  invariants: [
    {
      id: "decisions-as-list",
      description: "Each decision is one list item with its stage, question and answer, in order",
      check: ({ root, props }) => {
        const shown = Array.from(root.querySelectorAll(".task-notes__decision")).map((li) => [li.querySelector(".task-notes__question")?.textContent, li.querySelector(".task-notes__answer")?.textContent]);
        const expected = (props.context.decisions ?? []).map((d) => [d.question, d.answer]);
        return JSON.stringify(shown) === JSON.stringify(expected) || `shown=${JSON.stringify(shown)}`;
      },
    },
    {
      id: "risk-reasons-iff-high",
      description: "Risk reasons are listed if and only if the risk is high",
      check: ({ root, props }) => {
        const items = Array.from(root.querySelectorAll(".task-notes__reasons li")).map((li) => li.textContent);
        const high = props.context.risk?.level === "high";
        const expected = high ? (props.context.risk?.reasons ?? []) : [];
        const box = root.querySelector(".task-notes__risk") !== null;
        return (box === high && JSON.stringify(items) === JSON.stringify(expected)) || `box=${box} items=${JSON.stringify(items)}`;
      },
    },
    {
      id: "hidden-iff-empty",
      description: "The section is hidden if and only if there are no decisions and the risk is not high",
      check: ({ root, props }) => {
        const section = root.querySelector<HTMLElement>(".task-notes");
        const empty = (props.context.decisions ?? []).length === 0 && props.context.risk?.level !== "high";
        return section?.hidden === empty || `hidden=${section?.hidden} empty=${empty}`;
      },
    },
  ],
});
