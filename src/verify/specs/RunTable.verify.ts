import { createElement } from "react";
import { z } from "zod";
import { RunTable, type RunTableProps } from "../../dashboard/components/RunTable";
import { registerUnit } from "../core/registry";
import { run } from "./fixtures";

registerUnit<RunTableProps>({
  id: "RunTable",
  title: "RunTable",
  description: "List of browser test runs with status and counts.",
  kind: "component",
  render: (props) => createElement(RunTable, props),
  propsSchema: z.object({ runs: z.array(z.object({ id: z.string(), status: z.enum(["running", "passed", "failed", "error"]) }).loose()) }),
  fixtures: [
    {
      id: "history",
      description: "A running run above finished ones.",
      props: {
        runs: [
          run("r3-running-xxxx", "running"),
          run("r2-failed-xxxxx", "failed", { passed: 3, failed: 1, flaky: 0, skipped: 0, durationMs: 9000 }, "task-1"),
          run("r1-passed-xxxxx", "passed", { passed: 4, failed: 0, flaky: 1, skipped: 1, durationMs: 8000 }),
        ],
      },
    },
    { id: "empty", probe: true, description: "Probe: no runs yet.", props: { runs: [] } },
    { id: "error", probe: true, description: "Probe: a run that crashed has no summary.", props: { runs: [run("r9-error-xxxxxx", "error")] } },
  ],
  invariants: [
    {
      id: "rows-match-count",
      description: "One row per run, each linking to its page",
      check: ({ root, props }) => {
        const hrefs = Array.from(root.querySelectorAll("tbody a")).map((a) => a.getAttribute("href"));
        return JSON.stringify(hrefs) === JSON.stringify(props.runs.map((r) => `/runs/${r.id}`)) || `hrefs=${hrefs}`;
      },
    },
    {
      id: "running-count",
      description: "data-verify-running counts running runs",
      check: ({ contract, props }) => contract.running === String(props.runs.filter((r) => r.status === "running").length),
    },
    {
      id: "failures-mentioned",
      description: "A run with failures says how many failed",
      onlyFixtures: ["history"],
      check: ({ root }) => root.querySelector('[data-run-id="r2-failed-xxxxx"]')?.textContent?.includes("1 failed") === true,
    },
    {
      id: "empty-state-iff-empty",
      description: "Empty state shown if and only if there are no runs",
      check: ({ root, contract }) => (root.querySelector(".empty") !== null) === (contract.count === "0"),
    },
  ],
});
