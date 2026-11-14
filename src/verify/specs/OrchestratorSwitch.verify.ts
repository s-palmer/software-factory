import { createElement } from "react";
import { z } from "zod";
import { OrchestratorSwitch, type OrchestratorSwitchProps } from "../../dashboard/components/OrchestratorSwitch";
import { registerUnit } from "../core/registry";

const toggled: boolean[] = [];
const record: OrchestratorSwitchProps["onToggle"] = (running) => {
  toggled.push(running);
};

registerUnit<OrchestratorSwitchProps>({
  id: "OrchestratorSwitch",
  title: "OrchestratorSwitch",
  description: "On/off switch for the orchestrator loop; says 'not available' when the server has none.",
  kind: "component",
  render: (props) => {
    toggled.length = 0;
    return createElement(OrchestratorSwitch, props);
  },
  propsSchema: z.object({
    state: z.object({ available: z.boolean(), running: z.boolean() }).nullable(),
    onToggle: z.function(),
    busy: z.boolean().optional(),
    error: z.string().nullish(),
  }),
  fixtures: [
    { id: "off", description: "Available and stopped.", props: { state: { available: true, running: false }, onToggle: record } },
    { id: "on", description: "Available and running.", props: { state: { available: true, running: true }, onToggle: record } },
    { id: "turn-on", description: "Clicking the switch asks to start the loop.", props: { state: { available: true, running: false }, onToggle: record }, act: (ctx) => ctx.click("input") },
    {
      id: "not-available",
      probe: true,
      description: "Probe: no orchestrator on this server; the switch is disabled and never shows on, even if running is reported.",
      props: { state: { available: false, running: true }, onToggle: record },
    },
    { id: "loading", probe: true, description: "Probe: state not loaded yet.", props: { state: null, onToggle: record } },
    { id: "error", probe: true, description: "Probe: a failed toggle shows an alert.", props: { state: { available: true, running: false }, onToggle: record, error: "Orchestrator not available" } },
  ],
  invariants: [
    {
      id: "switch-matches-state",
      description: "The switch is checked if and only if the loop is available and running, and enabled only when available",
      check: ({ root, props }) => {
        const input = root.querySelector<HTMLInputElement>("input[role=switch]");
        const available = props.state?.available ?? false;
        const running = available && (props.state?.running ?? false);
        return (input?.checked === running && input.disabled === (!available || props.busy === true)) || `checked=${input?.checked} disabled=${input?.disabled}`;
      },
    },
    {
      id: "says-state",
      description: "The label says on, off, not available or loading",
      check: ({ root, props }) => {
        const text = root.querySelector(".orchestrator__state")?.textContent;
        const expected = props.state === null ? "loading" : !props.state.available ? "not available" : props.state.running ? "on" : "off";
        return text === expected || `text=${text} expected=${expected}`;
      },
    },
    { id: "click-reports", description: "Clicking the switch reports running=true once", onlyFixtures: ["turn-on"], check: () => toggled.join() === "true" || `toggled=${toggled}` },
    {
      id: "error-shown-iff-error",
      description: "An alert is shown if and only if there's an error",
      check: ({ root, props }) => (root.querySelector("[role=alert]")?.textContent ?? null) === (props.error ?? null),
    },
  ],
});
