import { createElement } from "react";
import { z } from "zod";
import { TaskStatusSchema } from "../../../shared/api";
import { statusLabel } from "../../../shared/lifecycle";
import { AgentRunList, type AgentRunListProps } from "../../dashboard/components/AgentRunList";
import { registerUnit } from "../core/registry";
import { agentRun } from "./fixtures";

// Deliberately out of order: the list must sort newest first.
const runs = [
  agentRun("r1", "scoping", "agent", "passed", { model: "claude-fable-5-2", costUsd: 0.42, turns: 12, summary: "Wrote the solution doc and 3 acceptance criteria.", startedAt: "2026-11-06T09:00:00" }),
  agentRun("r3", "implementing", "agent", "running", { startedAt: "2026-11-06T09:30:00" }),
  agentRun("r2", "test_writing", "red-check", "passed", { summary: "3 new tests fail as expected; locked.", startedAt: "2026-11-06T09:20:00" }),
  agentRun("r0", "backlog", "worktree", "passed", { startedAt: "2026-11-06T08:59:00" }),
];

registerUnit<AgentRunListProps>({
  id: "AgentRunList",
  title: "AgentRunList",
  description: "A task's agent runs and factory checks, newest first: stage, kind, model, status, cost, turns and summary.",
  kind: "component",
  render: (props) => createElement(AgentRunList, props),
  propsSchema: z.object({
    runs: z.array(
      z
        .object({
          id: z.string(),
          stage: TaskStatusSchema,
          kind: z.string().min(1),
          status: z.enum(["running", "passed", "failed", "error"]),
          model: z.string().nullable(),
          costUsd: z.number().nonnegative(),
          turns: z.number().int().nonnegative(),
          summary: z.string().nullable(),
          startedAt: z.string(),
        })
        .loose(),
    ),
  }),
  fixtures: [
    { id: "mixed", description: "Agent runs and factory checks across stages, one still running.", props: { runs } },
    {
      id: "same-second",
      probe: true,
      description: "Probe: runs started the same second (the API's precision); the running one is listed first.",
      props: {
        runs: [
          agentRun("g", "implementing", "gate", "failed", { startedAt: "2026-11-06T09:30:00" }),
          agentRun("a", "implementing", "agent", "running", { startedAt: "2026-11-06T09:30:00" }),
          agentRun("p", "test_writing", "agent", "passed", { startedAt: "2026-11-06T09:29:59" }),
        ],
      },
    },
    { id: "empty", probe: true, description: "Probe: no runs yet shows an empty state.", props: { runs: [] } },
    {
      id: "failed-long-summary",
      probe: true,
      description: "Probe: a failed run with a long summary and a cost that needs rounding.",
      props: { runs: [agentRun("x", "reviewing", "agent", "failed", { costUsd: 1.005, turns: 80, summary: "The reviewer found problems. ".repeat(30).trim() })] },
    },
  ],
  invariants: [
    {
      id: "newest-first",
      description: "One item per run, newest first; among runs started the same second, a running one first",
      check: ({ root, props }) => {
        const shown = Array.from(root.querySelectorAll<HTMLElement>(".agent-run")).map((li) => li.dataset.runId);
        const rank = (r: (typeof props.runs)[number]) => `${r.startedAt}|${r.status === "running" ? 1 : 0}`;
        const expected = [...props.runs].sort((a, b) => rank(b).localeCompare(rank(a))).map((r) => r.id);
        return shown.join() === expected.join() || `shown=${shown.join()} expected=${expected.join()}`;
      },
    },
    {
      id: "fields-shown",
      description: "Each run shows its stage, kind, model, status, cost to 2 decimals, turns, and summary if any",
      check: ({ root, props }) => {
        const bad = props.runs.filter((r) => {
          const li = root.querySelector<HTMLElement>(`.agent-run[data-run-id="${r.id}"]`);
          if (!li) return true;
          const text = (sel: string) => li.querySelector(sel)?.textContent ?? null;
          return (
            text(".agent-run__stage") !== statusLabel(r.stage) ||
            text(".agent-run__kind") !== r.kind ||
            text(".agent-run__model") !== (r.model ?? "none") ||
            text(".agent-run__status") !== r.status ||
            text(".agent-run__cost") !== `$${r.costUsd.toFixed(2)}` ||
            text(".agent-run__turns") !== String(r.turns) ||
            text(".agent-run__summary") !== r.summary
          );
        });
        return bad.length === 0 || `wrong: ${bad.map((r) => r.id).join(",")}`;
      },
    },
    {
      id: "contract-totals",
      description: "The contract counts runs, running runs and total cost",
      check: ({ props, contract }) => {
        const expected = { count: String(props.runs.length), running: String(props.runs.filter((r) => r.status === "running").length), cost: props.runs.reduce((n, r) => n + r.costUsd, 0).toFixed(2) };
        const actual = { count: contract.count, running: contract.running, cost: contract.cost };
        return JSON.stringify(actual) === JSON.stringify(expected) || `got ${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`;
      },
    },
    {
      id: "empty-state-iff-empty",
      description: "Empty-state message shown if and only if there are no runs",
      check: ({ root, props }) => (root.querySelector(".empty") !== null) === (props.runs.length === 0),
    },
  ],
});
