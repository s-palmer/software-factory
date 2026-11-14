/** Shared fixture data for dashboard specs. Images are inline SVGs so fixtures render without the API. */
import type { AgentRun, Artifact, TaskSummary, TestResult, TestRun } from "../../../shared/api";

const svg = (text: string, color: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="100%" height="100%" fill="${color}"/><text x="50%" y="50%" text-anchor="middle" font-family="sans-serif" font-size="20">${text}</text></svg>`)}`;

export const shot = (id: string, label: string, color = "#dde6f3"): Artifact => ({
  id,
  taskId: "t1",
  kind: "screenshot",
  path: `screenshots/${label}.png`,
  url: svg(label, color),
  label,
  createdAt: "2026-11-06T10:00:00",
});

export const shots: Artifact[] = [shot("s1", "AC-1 before", "#f3e1dd"), shot("s2", "AC-1 after"), shot("s3", "AC-2 after", "#e1f3dd")];

export const task = (id: string, title: string, status: TaskSummary["status"], extra: Partial<TaskSummary> = {}): TaskSummary => ({
  id,
  title,
  ticketKey: null,
  status,
  blockedBy: [],
  ready: status !== "done" && status !== "escalated",
  attempts: 0,
  costUsd: 0,
  screenshotCount: 0,
  updatedAt: "2026-11-06T10:00:00",
  ...extra,
});

export const agentRun = (id: string, stage: AgentRun["stage"], kind: string, status: AgentRun["status"], extra: Partial<AgentRun> = {}): AgentRun => ({
  id,
  taskId: "t1",
  stage,
  kind,
  status,
  model: kind === "agent" || kind === "decider" ? "claude-opus-5-5" : null,
  costUsd: 0,
  turns: 0,
  summary: null,
  output: null,
  logPath: null,
  startedAt: "2026-11-06T10:00:00",
  endedAt: status === "running" ? null : "2026-11-06T10:05:00",
  ...extra,
});

export const run = (id: string, status: TestRun["status"], summary: TestRun["summary"] = null, taskId: string | null = null): TestRun => ({
  id,
  taskId,
  status,
  startedAt: "2026-11-06T10:00:00",
  endedAt: status === "running" ? null : "2026-11-06T10:01:00",
  exitCode: status === "running" ? null : status === "passed" ? 0 : 1,
  summary,
  reportUrl: status === "running" ? null : `/artifacts/runs/${id}/playwright-report/index.html`,
});

export const results: TestResult[] = [
  {
    title: "create a task from the dashboard",
    file: "dashboard.spec.ts",
    status: "passed",
    durationMs: 640,
    error: null,
    attachments: [
      { name: "screenshot", kind: "screenshot", path: "runs/r1/a.png", url: shot("x", "after").url },
      { name: "trace", kind: "trace", path: "runs/r1/trace.zip", url: "/artifacts/runs/r1/trace.zip" },
    ],
  },
  {
    title: "review screenshots and request changes",
    file: "dashboard.spec.ts",
    status: "failed",
    durationMs: 1210,
    error: 'Expected: "implementing"\nReceived: "backlog"',
    attachments: [{ name: "screenshot", kind: "screenshot", path: "runs/r1/b.png", url: shot("y", "failure", "#f3dddd").url }],
  },
];
