import { createElement } from "react";
import { z } from "zod";
import { RunResults, type RunResultsProps } from "../../dashboard/components/RunResults";
import { registerUnit } from "../core/registry";
import { results } from "./fixtures";

const withVideo: RunResultsProps["results"] = [
  {
    ...results[0]!,
    attachments: [...results[0]!.attachments, { name: "video", kind: "video", path: "runs/r1/v.webm", url: "/artifacts/runs/r1/v.webm" }],
  },
];

registerUnit<RunResultsProps>({
  id: "RunResults",
  title: "RunResults",
  description: "Per-test results with the session's video, screenshots and trace.",
  kind: "component",
  render: (props) => createElement(RunResults, props),
  propsSchema: z.object({ results: z.array(z.object({ title: z.string(), status: z.string(), attachments: z.array(z.unknown()) }).loose()), reportUrl: z.string().nullish() }),
  fixtures: [
    { id: "mixed", description: "One pass, one failure with its error and screenshot.", props: { results, reportUrl: "/artifacts/runs/r1/playwright-report/index.html" } },
    { id: "video", description: "A test with a recorded video.", props: { results: withVideo } },
    { id: "empty", probe: true, description: "Probe: a run with no results.", props: { results: [] } },
    { id: "no-report", probe: true, description: "Probe: trace without an HTML report offers download only.", props: { results, reportUrl: null } },
  ],
  invariants: [
    {
      id: "failures-first",
      description: "Failed tests are listed first",
      check: ({ root }) => {
        const statuses = Array.from(root.querySelectorAll<HTMLElement>(".run-result")).map((li) => li.dataset.status);
        const firstNonFail = statuses.findIndex((s) => s !== "failed");
        return firstNonFail === -1 || !statuses.slice(firstNonFail).includes("failed") || `order=${statuses}`;
      },
    },
    {
      id: "errors-shown",
      description: "Every failed test shows its error",
      check: ({ root }) =>
        Array.from(root.querySelectorAll('.run-result[data-status="failed"]')).every((li) => (li.querySelector(".run-result__error")?.textContent ?? "").length > 0),
    },
    {
      id: "videos-rendered",
      description: "Each video attachment renders a playable <video>",
      check: ({ root, contract }) => {
        const videos = Array.from(root.querySelectorAll("video"));
        return (videos.length === Number(contract.videos) && videos.every((v) => v.hasAttribute("controls") && v.getAttribute("src"))) || `videos=${videos.length}`;
      },
    },
    {
      id: "trace-viewer-link-iff-report",
      description: "Trace viewer link appears if and only if there is a report",
      check: ({ root, props }) => {
        const hasTrace = props.results.some((r) => r.attachments.some((a) => a.kind === "trace"));
        const viewer = Array.from(root.querySelectorAll("a")).some((a) => a.textContent?.includes("trace viewer"));
        return viewer === (hasTrace && Boolean(props.reportUrl)) || `viewer=${viewer}`;
      },
    },
  ],
});
