import { createElement } from "react";
import { z } from "zod";
import { TaskStatusSchema } from "../../../shared/api";
import { WaitingFor, type WaitingForProps } from "../../dashboard/components/WaitingFor";
import { registerUnit } from "../core/registry";

const tasks: WaitingForProps["tasks"] = [
  { id: "t5", ticketKey: "#5", status: "implementing" },
  { id: "t6", ticketKey: "#6", status: "escalated" },
  { id: "t7", ticketKey: "#7", status: "done" },
  { id: "nokey-1234567890", ticketKey: null, status: "backlog" },
];

/** What the text must read, computed independently of the component. */
const expectedLabels = (p: WaitingForProps) =>
  p.blockedBy.filter((id) => p.tasks.find((t) => t.id === id)?.status !== "done").map((id) => p.tasks.find((t) => t.id === id)?.ticketKey ?? id.slice(0, 8));

registerUnit<WaitingForProps>({
  id: "WaitingFor",
  title: "WaitingFor",
  description: "'waiting for #5, #6': the unfinished blockers of a task, by ticket key, each linking to its task.",
  kind: "component",
  render: (props) => createElement(WaitingFor, props),
  propsSchema: z.object({
    blockedBy: z.array(z.string()),
    tasks: z.array(z.object({ id: z.string(), ticketKey: z.string().nullable(), status: TaskStatusSchema })),
  }),
  fixtures: [
    { id: "two-blockers", description: "Two unfinished blockers (an escalated blocker still blocks).", props: { blockedBy: ["t5", "t6"], tasks } },
    { id: "one-done", probe: true, description: "Probe: a done blocker is left out.", props: { blockedBy: ["t5", "t7"], tasks } },
    { id: "all-done", probe: true, description: "Probe: every blocker done renders nothing visible.", props: { blockedBy: ["t7"], tasks } },
    { id: "none", probe: true, description: "Probe: no blockers.", props: { blockedBy: [], tasks } },
    { id: "unknown-and-keyless", probe: true, description: "Probe: a blocker not in the list, and one without a ticket key, show a short id.", props: { blockedBy: ["zz-missing-task-id", "nokey-1234567890"], tasks } },
  ],
  invariants: [
    {
      id: "reads-waiting-for",
      description: "Text reads 'waiting for <keys, comma separated>' with exactly the unfinished blockers",
      check: ({ root, props }) => {
        const labels = expectedLabels(props);
        const el = root.querySelector<HTMLElement>(".waiting-for");
        if (labels.length === 0) return el?.hidden === true || "should be hidden";
        const text = el?.textContent?.replace(/\s+/g, " ").trim();
        return (el?.hidden === false && text === `waiting for ${labels.join(", ")}`) || `text="${text}"`;
      },
    },
    {
      id: "links-to-blockers",
      description: "Each blocker links to its task page",
      check: ({ root, props }) => {
        const hrefs = Array.from(root.querySelectorAll(".waiting-for a")).map((a) => a.getAttribute("href"));
        const expected = props.blockedBy.filter((id) => props.tasks.find((t) => t.id === id)?.status !== "done").map((id) => `/tasks/${encodeURIComponent(id)}`);
        return JSON.stringify(hrefs) === JSON.stringify(expected) || `hrefs=${JSON.stringify(hrefs)}`;
      },
    },
    {
      id: "contract-count",
      description: "The contract counts the unfinished blockers",
      check: ({ props, contract }) => contract.count === String(expectedLabels(props).length) || `count=${contract.count}`,
    },
  ],
});
