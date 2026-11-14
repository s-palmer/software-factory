import { createElement } from "react";
import { z } from "zod";
import { TaskStatusSchema } from "../../../shared/api";
import { AWAITING_HUMAN } from "../../../shared/lifecycle";
import { formatDuration, TaskTable, type TaskTableProps } from "../../dashboard/components/TaskTable";
import { registerUnit } from "../core/registry";
import { task } from "./fixtures";

registerUnit<TaskTableProps>({
  id: "TaskTable",
  title: "TaskTable",
  description: "List of tasks with ticket, status, attempts, cost, and a 'Needs you' marker for escalated tasks.",
  kind: "component",
  render: (props) => createElement(TaskTable, props),
  propsSchema: z.object({
    tasks: z.array(
      z.object({
        id: z.string(),
        title: z.string().min(1),
        ticketKey: z.string().nullable(),
        status: TaskStatusSchema,
        attempts: z.number().int().nonnegative(),
        costUsd: z.number().nonnegative(),
        blockedBy: z.array(z.string()),
        ready: z.boolean(),
        screenshotCount: z.number().int().nonnegative(),
        updatedAt: z.string(),
        durationSec: z.number().nonnegative(),
        durationFinal: z.boolean(),
      }),
    ),
  }),
  fixtures: [
    {
      id: "mixed",
      description: "Tasks across the pipeline, one escalated.",
      props: {
        tasks: [
          task("a", "Add login page", "escalated", { ticketKey: "#7", screenshotCount: 4, attempts: 3, costUsd: 4.567, durationSec: 3 * 3600 + 5 * 60 + 9 }),
          task("b", "Fix nav overflow", "implementing", { ticketKey: "#9", attempts: 1, costUsd: 0.5 }),
          task("c", "Scope billing", "scoping", { costUsd: 0.1 }),
          task("d", "Write README", "done", { screenshotCount: 1, costUsd: 1.2, durationSec: 38 * 60 + 40 }),
          task("e", "Tidy spacing", "reviewing", { attempts: 2 }),
          task("f", "Fix typo", "browser_check"),
        ],
      },
    },
    {
      id: "running-time",
      probe: true,
      description: "Probe: a task still in progress shows its time so far; a long one shows days and hours.",
      props: { tasks: [task("r", "Paginate the list", "implementing", { durationSec: 754, durationFinal: false }), task("l", "Big refactor", "awaiting_merge", { durationSec: 2 * 86400 + 3 * 3600 })] },
    },
    { id: "empty", probe: true, description: "Probe: no tasks shows an empty state, not an empty table.", props: { tasks: [] } },
    {
      id: "long-title",
      probe: true,
      description: "Probe: a very long title and a task id that needs URL encoding.",
      props: { tasks: [task("id with spaces/?", "Refactor ".repeat(25).trim(), "escalated")] },
    },
    {
      id: "blocked",
      description: "#12 waits for #5 (implementing) and #4 (done): only #5 is listed. #13 is ready.",
      props: {
        tasks: [
          task("t12", "#12", "backlog", { ticketKey: "#12", blockedBy: ["t5", "t4"], ready: false }),
          task("t5", "Build the API", "implementing", { ticketKey: "#5" }),
          task("t4", "Schema", "done", { ticketKey: "#4" }),
          task("t13", "#13", "backlog", { ticketKey: "#13", blockedBy: ["t4"] }),
        ],
      },
    },
    {
      id: "escalated-blocker",
      probe: true,
      description: "Probe: a blocker that escalated keeps blocking; a blocker missing from the list shows its short id.",
      props: {
        tasks: [
          task("t20", "#20", "backlog", { ticketKey: "#20", blockedBy: ["t21", "gone-0000-1111"], ready: false }),
          task("t21", "Broken", "escalated", { ticketKey: "#21" }),
        ],
      },
    },
    {
      id: "rounding",
      probe: true,
      description: "Probe: costs that need rounding (sub-cent, many decimals, large) still show two decimals.",
      props: { tasks: [task("a", "A", "pr", { costUsd: 0.129 }), task("b", "B", "awaiting_merge", { costUsd: 0.004 }), task("c", "C", "done", { costUsd: 1234.5 })] },
    },
  ],
  invariants: [
    {
      id: "row-cells-match-task",
      description: "Each row shows the task's ticket, status, attempts, cost to 2 decimals, and its time (marked 'so far' while it runs)",
      check: ({ root, props }) => {
        const rows = Array.from(root.querySelectorAll<HTMLElement>("tbody tr"));
        const bad = props.tasks.filter((t, i) => {
          const row = rows[i];
          if (!row) return true;
          const cost = row.querySelector(".task-table__cost")?.textContent ?? "";
          return (
            row.querySelector(".task-table__ticket")?.textContent !== (t.ticketKey ?? "") ||
            row.querySelector(".status-badge")?.getAttribute("data-status") !== t.status ||
            row.querySelector(".task-table__attempts")?.textContent !== String(t.attempts) ||
            !/^\$\d+\.\d\d$/.test(cost) ||
            cost !== `$${t.costUsd.toFixed(2)}` ||
            row.querySelector(".task-table__time")?.textContent !== formatDuration(t.durationSec) + (t.durationFinal === false ? " so far" : "")
          );
        });
        return bad.length === 0 || `wrong rows: ${bad.map((t) => t.id).join(",")}`;
      },
    },
    {
      id: "waiting-shown-iff-blocked",
      description: "A row says 'waiting for ...' exactly when the task isn't ready and has unfinished blockers",
      check: ({ root, props, contract }) => {
        const shown = Array.from(root.querySelectorAll<HTMLElement>("tbody tr"))
          .filter((tr) => {
            const w = tr.querySelector<HTMLElement>(".waiting-for");
            return w !== null && !w.hidden;
          })
          .map((tr) => tr.dataset.taskId);
        const expected = props.tasks
          .filter((t) => !t.ready && t.blockedBy.some((id) => props.tasks.find((x) => x.id === id)?.status !== "done"))
          .map((t) => t.id);
        return (shown.join() === expected.join() && contract.waiting === String(expected.length)) || `shown=${shown.join()} expected=${expected.join()} contract=${contract.waiting}`;
      },
    },
    {
      id: "cost-total",
      description: "The contract's cost is the sum of task costs, to 2 decimals",
      check: ({ props, contract }) => {
        const expected = props.tasks.reduce((n, t) => n + t.costUsd, 0).toFixed(2);
        return contract.cost === expected || `cost=${contract.cost} expected=${expected}`;
      },
    },
    {
      id: "rows-match-count",
      description: "One row per task",
      check: ({ root, contract }) => {
        const rows = root.querySelectorAll("tbody tr").length;
        return rows === Number(contract.count) || `rows=${rows} count=${contract.count}`;
      },
    },
    {
      id: "awaiting-marked",
      description: "Exactly the escalated tasks show 'Needs you'",
      check: ({ root, contract, props }) => {
        const marked = root.querySelectorAll(".needs-you").length;
        const expected = props.tasks.filter((t) => AWAITING_HUMAN.has(t.status)).length;
        return (marked === expected && String(expected) === contract.awaiting) || `marked=${marked} expected=${expected} contract=${contract.awaiting}`;
      },
    },
    {
      id: "links-to-task",
      description: "Each title links to its task page (URL-encoded id)",
      check: ({ root, props }) => {
        const hrefs = Array.from(root.querySelectorAll("tbody .task-table__title > a")).map((a) => a.getAttribute("href"));
        const expected = props.tasks.map((t) => `/tasks/${encodeURIComponent(t.id)}`);
        return JSON.stringify(hrefs) === JSON.stringify(expected) || `hrefs=${JSON.stringify(hrefs)}`;
      },
    },
    {
      id: "empty-state-iff-empty",
      description: "Empty-state message shown if and only if there are no tasks",
      check: ({ root, contract }) => (root.querySelector(".empty") !== null) === (contract.count === "0"),
    },
  ],
});
