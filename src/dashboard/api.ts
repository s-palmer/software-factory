import type { Artifact, CreateTaskInput, Learning, UpdateLearningInput, DefaultModels, EnvStatus, TrackerInfo, Feedback, FeedbackInput, RunDetail, SetDefaultModelsInput, SetModelsInput, StartRunInput, Task, TaskDetail, TaskSummary, TestRun } from "../../shared/api";
import type { RiskPolicy } from "../../shared/risk";

/** The orchestrator loop. `available: false` when the server runs without one (e.g. tests). */
export interface OrchestratorState {
  available: boolean;
  running: boolean;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

async function envAction(action: "start" | "stop"): Promise<{ ok: boolean; message: string }> {
  const res = await fetch(`/api/env/${action}`, { method: "POST" });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
  return { ok: res.ok && body.ok === true, message: body.message ?? body.error ?? `Request failed (${res.status})` };
}

export const api = {
  listTasks: () => request<TaskSummary[]>("/api/tasks"),
  getTask: (id: string) => request<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`),
  createTask: (input: CreateTaskInput) => request<Task>("/api/tasks", { method: "POST", body: JSON.stringify(input) }),
  sendFeedback: (id: string, input: FeedbackInput) =>
    request<{ task: Task; feedback: Feedback }>(`/api/tasks/${encodeURIComponent(id)}/feedback`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  setModels: (id: string, input: SetModelsInput) =>
    request<Task>(`/api/tasks/${encodeURIComponent(id)}/models`, { method: "PUT", body: JSON.stringify(input) }),
  getDefaultModels: () => request<DefaultModels>("/api/models"),
  setDefaultModels: (input: SetDefaultModelsInput) => request<DefaultModels>("/api/models", { method: "PUT", body: JSON.stringify(input) }),
  stepTask: (id: string) => request<{ ok: true }>(`/api/tasks/${encodeURIComponent(id)}/step`, { method: "POST" }),
  getOrchestrator: () => request<OrchestratorState>("/api/orchestrator"),
  setOrchestrator: (running: boolean) => request<OrchestratorState>("/api/orchestrator", { method: "PUT", body: JSON.stringify({ running }) }),
  getPolicy: () => request<RiskPolicy>("/api/policy"),
  getEnv: () => request<EnvStatus>("/api/env"),
  getTracker: () => request<TrackerInfo>("/api/tracker"),
  listLearnings: () => request<Learning[]>("/api/learnings"),
  updateLearning: (id: string, change: UpdateLearningInput) => request<Learning>(`/api/learnings/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(change) }),
  applyLearnings: () => request<{ factory: number; tasks: Array<{ learningId: string; taskId: string }> }>("/api/learnings/apply", { method: "POST" }),
  removeArtifact: (id: string) => request<Artifact>(`/api/artifacts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  // A refused start or stop (409) still carries a message for the page.
  startEnv: () => envAction("start"),
  stopEnv: () => envAction("stop"),
  listRuns: () => request<TestRun[]>("/api/runs"),
  getRun: (id: string) => request<RunDetail>(`/api/runs/${encodeURIComponent(id)}`),
  startRun: (input: StartRunInput = {}) => request<TestRun>("/api/runs", { method: "POST", body: JSON.stringify(input) }),
};
