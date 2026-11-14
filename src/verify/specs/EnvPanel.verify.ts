import { createElement } from "react";
import { z } from "zod";
import type { EnvStatus } from "../../../shared/api";
import { EnvPanel, envState, type EnvPanelProps } from "../../dashboard/components/EnvPanel";
import { registerUnit } from "../core/registry";

const clicks: string[] = [];
const onStart = () => void clicks.push("start");
const onStop = () => void clicks.push("stop");

const base: EnvStatus = {
  configured: true,
  command: "pnpm run dev",
  url: "http://localhost:5173",
  healthUrls: ["http://localhost:5173"],
  up: false,
  lease: null,
  external: false,
  portHolders: [],
  waiting: [],
  log: "",
};
const taskLease: NonNullable<EnvStatus["lease"]> = {
  holder: "task",
  taskId: "t-123",
  ticketKey: "#42",
  title: "Paginate the task list",
  status: "browser_check",
  pid: 4242,
  running: true,
  acquiredAt: "2026-11-14 09:30:00",
  logPath: "/tmp/env.log",
};

registerUnit<EnvPanelProps>({
  id: "EnvPanel",
  title: "EnvPanel",
  description: "The local environment for the browser check: up or down, which task or person holds it, who waits, start and stop for a person.",
  kind: "component",
  render: (props) => {
    clicks.length = 0;
    return createElement(EnvPanel, props);
  },
  propsSchema: z.object({
    status: z.custom<EnvStatus>().nullable(),
    onStart: z.function(),
    onStop: z.function(),
    busy: z.boolean().optional(),
    message: z.object({ ok: z.boolean(), text: z.string() }).nullish(),
  }),
  fixtures: [
    { id: "free", description: "Nobody holds it; a person can start it.", props: { status: base, onStart, onStop } },
    {
      id: "task-holds",
      description: "A task's browser check runs it, and another task waits.",
      props: {
        status: { ...base, up: true, lease: taskLease, log: "VITE ready on http://localhost:5173", waiting: [{ taskId: "t-9", ticketKey: "LI-7", title: "Sort columns", reason: "Another task is using the local app." }] },
        onStart,
        onStop,
      },
    },
    { id: "person-holds", description: "A person started it; they can stop it.", props: { status: { ...base, up: true, lease: { ...taskLease, holder: "person", taskId: null, ticketKey: null, title: null, status: null } }, onStart, onStop } },
    { id: "stop", description: "Stop asks to stop the person's copy.", props: { status: { ...base, up: true, lease: { ...taskLease, holder: "person", taskId: null, ticketKey: null, title: null, status: null } }, onStart, onStop }, act: (ctx) => ctx.click(".env__stop") },
    { id: "start", description: "Start asks to start a copy.", props: { status: base, onStart, onStop }, act: (ctx) => ctx.click(".env__start") },
    {
      id: "external",
      probe: true,
      description: "Probe: the app answers but the factory did not start it; it names the process and nobody can start or stop it here.",
      props: { status: { ...base, up: true, external: true, portHolders: [{ port: 5173, pid: 99, command: "node" }] }, onStart, onStop },
    },
    { id: "not-configured", probe: true, description: "Probe: no start command; start is disabled and the panel says how to fix it.", props: { status: { ...base, configured: false, command: null }, onStart, onStop } },
    { id: "dead-process", probe: true, description: "Probe: the task's process has exited but still holds the lease.", props: { status: { ...base, lease: { ...taskLease, running: false } }, onStart, onStop } },
    { id: "loading", probe: true, description: "Probe: not loaded yet.", props: { status: null, onStart, onStop } },
    { id: "refused", probe: true, description: "Probe: a refused start shows an alert.", props: { status: base, onStart, onStop, message: { ok: false, text: "The local environment is in use." } } },
  ],
  invariants: [
    {
      id: "names-the-holder",
      description: "When a task holds it, the panel links to that task and shows its ticket key",
      check: ({ root, props }) => {
        if (props.status?.lease?.holder !== "task") return true;
        const link = root.querySelector<HTMLAnchorElement>(".env__holder a");
        return (link?.getAttribute("href") === `/tasks/${props.status.lease.taskId}` && link.textContent?.includes(props.status.lease.ticketKey ?? "")) || `link=${link?.outerHTML}`;
      },
    },
    {
      id: "buttons-match-state",
      description: "Start is enabled only when free and configured; stop only when a person holds it",
      check: ({ root, props }) => {
        const state = envState(props.status);
        const start = root.querySelector<HTMLButtonElement>(".env__start");
        const stop = root.querySelector<HTMLButtonElement>(".env__stop");
        if (state === "loading") return (start === null && stop === null) || "buttons shown while loading";
        const wantStart = state === "free" && props.status!.configured && !props.busy;
        const wantStop = state === "person" && !props.busy;
        return (start?.disabled === !wantStart && stop?.disabled === !wantStop) || `start.disabled=${start?.disabled} stop.disabled=${stop?.disabled} state=${state}`;
      },
    },
    {
      id: "lists-waiting",
      description: "Every waiting task is listed with its reason",
      check: ({ root, props }) => {
        const items = root.querySelectorAll(".env__waiting li");
        const want = props.status?.waiting ?? [];
        return (items.length === want.length && want.every((w, i) => items[i]?.textContent?.includes(w.reason))) || `listed ${items.length} of ${want.length}`;
      },
    },
    {
      id: "external-names-process",
      description: "An app outside the factory is reported with the process on its port",
      onlyFixtures: ["external"],
      check: ({ root }) => root.querySelector(".env__ports")?.textContent?.includes("node (pid 99) on port 5173") || "process not named",
    },
    {
      id: "dead-process-said",
      description: "A holder whose process exited is reported",
      onlyFixtures: ["dead-process"],
      check: ({ root }) => root.querySelector(".env__holder")?.textContent?.includes("has exited") || "exit not reported",
    },
    { id: "start-reports", description: "Clicking start reports once", onlyFixtures: ["start"], check: () => clicks.join() === "start" || `clicks=${clicks}` },
    { id: "stop-reports", description: "Clicking stop reports once", onlyFixtures: ["stop"], check: () => clicks.join() === "stop" || `clicks=${clicks}` },
    {
      id: "alert-iff-refused",
      description: "An alert is shown if and only if the last action failed",
      check: ({ root, props }) => Boolean(root.querySelector("[role=alert]")) === (props.message?.ok === false) || "alert mismatch",
    },
  ],
});
