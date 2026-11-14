import { createElement } from "react";
import { z } from "zod";
import { TaskStatusSchema } from "../../../shared/api";
import { PIPELINE } from "../../../shared/lifecycle";
import { PipelineOverview, type PipelineOverviewProps } from "../../dashboard/components/PipelineOverview";
import { registerUnit } from "../core/registry";
import { task } from "./fixtures";

const mixed = [
  task("a", "A", "implementing"),
  task("b", "B", "implementing"),
  task("c", "C", "browser_check"),
  task("g", "G", "awaiting_merge"),
  task("d", "D", "done"),
  task("e", "E", "backlog"),
];

registerUnit<PipelineOverviewProps>({
  id: "PipelineOverview",
  title: "PipelineOverview",
  description: "Task counts per pipeline stage across the factory.",
  kind: "component",
  render: (props) => createElement(PipelineOverview, props),
  propsSchema: z.object({ tasks: z.array(z.object({ id: z.string(), status: TaskStatusSchema }).loose()) }),
  fixtures: [
    { id: "mixed", description: "Tasks spread across stages, none escalated.", props: { tasks: mixed } },
    { id: "empty", probe: true, description: "Probe: no tasks.", props: { tasks: [] } },
    { id: "escalated", probe: true, description: "Probe: an escalated task gets its own column.", props: { tasks: [...mixed, task("f", "F", "escalated")] } },
  ],
  invariants: [
    {
      id: "one-column-per-stage",
      description: "One column per pipeline stage, in order, plus Escalated last when present",
      check: ({ root, contract }) => {
        const shown = Array.from(root.querySelectorAll<HTMLElement>(".overview__stages li")).map((li) => li.dataset.status);
        const expected = [...PIPELINE.map((s) => s.status), ...(contract.escalated !== "0" ? ["escalated"] : [])];
        return shown.join() === expected.join() || `shown=${shown.join()}`;
      },
    },
    {
      id: "decision-note-iff-awaiting",
      description: "'need a decision' shows if and only if a task is escalated, with the right count",
      check: ({ root, contract }) => {
        const note = root.querySelector(".overview__awaiting")?.textContent ?? null;
        return contract.awaiting === "0" ? note === null || `note=${note}` : note === `${contract.awaiting} need a decision` || `note=${note}`;
      },
    },
    {
      id: "stage-counts-add-up",
      description: "Per-stage counts add up to the total",
      check: ({ root, contract }) => {
        const sum = Array.from(root.querySelectorAll<HTMLElement>(".overview__stages li")).reduce((n, li) => n + Number(li.dataset.count), 0);
        return sum === Number(contract.total) || `sum=${sum} total=${contract.total}`;
      },
    },
    {
      id: "stage-counts-correct",
      description: "Each stage shows how many tasks are in it",
      check: ({ root, props }) => {
        const wrong = Array.from(root.querySelectorAll<HTMLElement>(".overview__stages li")).filter(
          (li) => Number(li.dataset.count) !== props.tasks.filter((t) => t.status === li.dataset.status).length,
        );
        return wrong.length === 0 || `wrong: ${wrong.map((li) => li.dataset.status).join(",")}`;
      },
    },
    {
      id: "in-flight-plus-done",
      description: "In-flight + done = total",
      check: ({ contract }) => Number(contract["in-flight"]) + Number(contract.done) === Number(contract.total),
    },
    {
      id: "escalated-column-iff-escalated",
      description: "Escalated column appears if and only if a task is escalated",
      check: ({ root, contract }) => (root.querySelector('[data-status="escalated"]') !== null) === (contract.escalated !== "0"),
    },
  ],
});
