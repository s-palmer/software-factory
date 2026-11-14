import { createElement } from "react";
import { z } from "zod";
import type { SteerInput } from "../../../shared/api";
import { TaskStatusSchema } from "../../../shared/api";
import { SteerPanel, type SteerPanelProps } from "../../dashboard/components/SteerPanel";
import { registerUnit } from "../core/registry";

const sent: Array<SteerInput | { paused: boolean }> = [];
const onSteer: SteerPanelProps["onSteer"] = (input) => {
  sent.push(input);
};
const onPause: SteerPanelProps["onPause"] = (paused) => {
  sent.push({ paused });
};
const notes = [
  { note: "Use the existing card component", by: "human", at: "2026-11-14T12:00:00Z" },
  { note: "Skip the legacy page", by: "agent:conductor", at: "2026-11-14T12:05:00Z" },
];
const base: SteerPanelProps = { status: "implementing", steering: notes, onSteer, onPause };

registerUnit<SteerPanelProps>({
  id: "SteerPanel",
  title: "SteerPanel",
  description: "Steer a running task: notes for every later run, Stop and redo the stage, and Pause or Resume.",
  kind: "component",
  render: (props) => {
    sent.length = 0;
    return createElement(SteerPanel, props);
  },
  propsSchema: z.object({
    status: TaskStatusSchema,
    steering: z.array(z.object({ note: z.string(), by: z.string(), at: z.string() })).optional(),
    paused: z.boolean().optional(),
    onSteer: z.function(),
    onPause: z.function(),
    error: z.string().nullish(),
  }),
  fixtures: [
    { id: "running", description: "A task in implement with two notes, in order, with who wrote them.", props: base },
    {
      id: "add-note",
      description: "Type a note and add it: sent trimmed, without a restart, and the box clears.",
      props: base,
      act: async (ctx) => {
        await ctx.type("#steer-note", "  Keep the old URL  ");
        await ctx.click(".steer-add");
      },
    },
    {
      id: "restart",
      description: "Type a note and stop the run: sent with restart.",
      props: base,
      act: async (ctx) => {
        await ctx.type("#steer-note", "Wrong file");
        await ctx.click(".steer-restart");
      },
    },
    { id: "pause", description: "Pause sends paused=true.", props: base, act: (ctx) => ctx.click(".steer-pause") },
    { id: "paused", probe: true, description: "Probe: a paused task says so, offers Resume, and has no run to stop.", props: { ...base, paused: true } },
    { id: "escalated", probe: true, description: "Probe: an escalated task takes notes but has no run to stop.", props: { ...base, status: "escalated" } },
    { id: "done", probe: true, description: "Probe: a done task shows its notes and takes no more.", props: { ...base, status: "done" } },
    { id: "no-notes", probe: true, description: "Probe: no notes yet: no list.", props: { ...base, steering: [] } },
    { id: "server-error", probe: true, description: "Probe: an API error is shown as an alert.", props: { ...base, error: "Task not found" } },
  ],
  invariants: [
    {
      id: "notes-in-order",
      description: "Each note is one list item, in order, with its author; no list when there are none",
      check: ({ root, props }) => {
        const items = Array.from(root.querySelectorAll(".steer__notes li")).map((li) => li.textContent);
        const want = (props.steering ?? []).map((s) => `${s.note} (${s.by})`);
        return JSON.stringify(items) === JSON.stringify(want) || `items=${JSON.stringify(items)}`;
      },
    },
    {
      id: "no-controls-when-done",
      description: "A done task has no note box or buttons; any other task has all three buttons",
      check: ({ root, props }) => {
        const controls = root.querySelectorAll("#steer-note, .steer-add, .steer-restart, .steer-pause").length;
        return controls === (props.status === "done" ? 0 : 4) || `controls=${controls}`;
      },
    },
    {
      id: "restart-only-when-running",
      description: "Stop and redo is enabled only with a note, on a task the factory is working on and not paused",
      check: ({ root, props, contract }) => {
        const btn = root.querySelector<HTMLButtonElement>(".steer-restart");
        if (!btn) return true;
        const can = contract["has-note"] === "true" && !props.paused && !["escalated", "awaiting_approval", "done"].includes(props.status);
        return btn.disabled === !can || `disabled=${btn.disabled} can=${can}`;
      },
    },
    {
      id: "pause-label",
      description: "The pause button says Resume when paused, Pause otherwise",
      check: ({ root, props }) => {
        const btn = root.querySelector(".steer-pause");
        return !btn || btn.textContent === (props.paused ? "Resume" : "Pause") || `label=${btn.textContent}`;
      },
    },
    {
      id: "sends-what-was-asked",
      description: "Add note, Stop and Pause each send exactly one call, and the note box clears after a note",
      onlyFixtures: ["add-note", "restart", "pause"],
      check: ({ root, fixture }) => {
        const want = { "add-note": { note: "Keep the old URL", restart: false }, restart: { note: "Wrong file", restart: true }, pause: { paused: true } }[fixture.id];
        const box = root.querySelector<HTMLTextAreaElement>("#steer-note")?.value;
        return (JSON.stringify(sent) === JSON.stringify([want]) && (fixture.id === "pause" || box === "")) || `sent=${JSON.stringify(sent)} box="${box}"`;
      },
    },
    {
      id: "error-shown-iff-error",
      description: "An alert is shown if and only if there is an error (a done task shows none)",
      check: ({ root, props }) => (root.querySelector("[role=alert]")?.textContent ?? null) === (props.status === "done" ? null : (props.error ?? null)),
    },
  ],
});
