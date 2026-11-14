import { createElement } from "react";
import { z } from "zod";
import { TaskStatusSchema } from "../../../shared/api";
import { pipelineFor, pipelinePosition } from "../../../shared/lifecycle";
import { PipelineProgress, type PipelineProgressProps } from "../../dashboard/components/PipelineProgress";
import { registerUnit } from "../core/registry";

const expectedStages = (p: PipelineProgressProps) => pipelineFor({ needsBrowser: p.needsBrowser, current: p.status });
const position = (p: PipelineProgressProps) => pipelinePosition(p.status, { needsBrowser: p.needsBrowser });

registerUnit<PipelineProgressProps>({
  id: "PipelineProgress",
  title: "PipelineProgress",
  description: "Where a task is in the pipeline, who acts on it (an agent or the factory), and what comes after.",
  kind: "component",
  render: (props) => createElement(PipelineProgress, props),
  propsSchema: z.object({ status: TaskStatusSchema, needsBrowser: z.boolean().optional(), compact: z.boolean().optional() }),
  fixtures: [
    { id: "implementing", description: "Mid-pipeline, an agent is working; browser need unknown, so the browser check shows.", props: { status: "implementing" } },
    { id: "reviewing-no-browser", description: "Reviewing a change that needs no browser: the next stage is the pull request.", props: { status: "reviewing", needsBrowser: false } },
    { id: "reviewing-browser", description: "Reviewing a visible change: the browser check comes next.", props: { status: "reviewing", needsBrowser: true } },
    { id: "awaiting_merge", description: "The factory merges.", props: { status: "awaiting_merge", needsBrowser: false } },
    { id: "backlog", probe: true, description: "Probe: first stage, nothing done yet.", props: { status: "backlog" } },
    { id: "done", probe: true, description: "Probe: last stage, nothing next.", props: { status: "done" } },
    { id: "escalated", probe: true, description: "Probe: escalated sits outside the pipeline; no stage is current.", props: { status: "escalated", needsBrowser: true } },
    {
      id: "in-browser-check-but-not-needed",
      probe: true,
      description: "Probe: a task sitting in the browser check after needsBrowser became false still shows where it is.",
      props: { status: "browser_check", needsBrowser: false },
    },
    { id: "compact", description: "One-line version used in the task table.", props: { status: "reviewing", compact: true } },
  ],
  invariants: [
    {
      id: "browser-step-iff-needed",
      description: "The browser check is shown unless needsBrowser is false (kept while the task is in it)",
      check: ({ root, props }) => {
        if (props.compact) return true;
        const shown = root.querySelector('.pipeline__steps li[data-status="browser_check"]') !== null;
        const expected = props.needsBrowser !== false || props.status === "browser_check";
        return shown === expected || `shown=${shown} expected=${expected}`;
      },
    },
    {
      id: "steps-match-pipeline",
      description: "The steps are the task's pipeline, in order, each with its actor",
      check: ({ root, props }) => {
        if (props.compact) return true;
        const shown = Array.from(root.querySelectorAll<HTMLElement>(".pipeline__steps li")).map((li) => `${li.dataset.status}:${li.dataset.actor}`);
        const expected = expectedStages(props).map((s) => `${s.status}:${s.actor}`);
        return shown.join() === expected.join() || `shown=${shown.join()} expected=${expected.join()}`;
      },
    },
    {
      id: "contract-matches-pipeline",
      description: "step, total, actor and next in the contract match the pipeline definition",
      check: ({ contract, props }) => {
        const pos = position(props);
        const expected = { step: String(pos.index + 1), total: String(expectedStages(props).length), actor: pos.stage.actor, next: pos.next?.status ?? "" };
        const actual = { step: contract.step, total: contract.total, actor: contract.actor, next: contract.next };
        return JSON.stringify(actual) === JSON.stringify(expected) || `expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`;
      },
    },
    {
      id: "current-step-marked",
      description: "Earlier stages are done, exactly the task's stage is current (none when escalated), later ones upcoming",
      check: ({ root, props }) => {
        if (props.compact) return true;
        const items = Array.from(root.querySelectorAll<HTMLElement>(".pipeline__steps li"));
        const states = items.map((li) => li.dataset.state);
        const { index } = position(props);
        const expected = expectedStages(props).map((_, i) => (index === -1 ? "upcoming" : i < index ? "done" : i === index ? "current" : "upcoming"));
        const current = Array.from(root.querySelectorAll<HTMLElement>('[aria-current="step"]')).map((li) => li.dataset.status);
        const expectedCurrent = index === -1 ? [] : [props.status];
        return (JSON.stringify(states) === JSON.stringify(expected) && current.join() === expectedCurrent.join()) || `states=${states.join(",")} current=${current}`;
      },
    },
    {
      id: "no-human-actor",
      description: "Every stage is run by an agent or the factory; nothing says it waits on 'you'",
      check: ({ root, contract }) => {
        const actors = [contract.actor, ...Array.from(root.querySelectorAll<HTMLElement>("[data-actor]")).map((el) => el.dataset.actor)];
        const bad = actors.filter((a) => a !== "agent" && a !== "system");
        return (bad.length === 0 && !/waiting on you/i.test(root.textContent ?? "")) || `actors=${actors.join()}`;
      },
    },
    {
      id: "says-what-is-next",
      description: "Shows the next stage's label if and only if there is one",
      check: ({ root, props }) => {
        const next = position(props).next;
        const text = root.textContent ?? "";
        return next ? text.includes(next.label) : !root.querySelector(".pipeline__then, .pipeline__next");
      },
    },
    {
      id: "progress-bar-matches",
      description: "Compact progress bar value equals the step",
      onlyFixtures: ["compact"],
      check: ({ root, contract }) => root.querySelector("progress")?.getAttribute("value") === contract.step,
    },
  ],
});
