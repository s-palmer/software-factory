import { useCallback, useEffect, useState } from "react";
import type { CreateTaskInput, TaskSummary, TrackerInfo } from "../../../shared/api";
import { api, type OrchestratorState } from "../api";
import { NewTaskForm } from "../components/NewTaskForm";
import { OrchestratorSwitch } from "../components/OrchestratorSwitch";
import { PipelineOverview } from "../components/PipelineOverview";
import { TaskTable } from "../components/TaskTable";

export function HomePage() {
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [orchestrator, setOrchestrator] = useState<OrchestratorState | null>(null);
  const [tracker, setTracker] = useState<TrackerInfo>({ type: "github" });
  const [orchestratorBusy, setOrchestratorBusy] = useState(false);
  const [orchestratorError, setOrchestratorError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.listTasks().then(setTasks, (err: unknown) => setLoadError(String(err instanceof Error ? err.message : err)));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    // An API without the route (or down) counts as "not available".
    api.getOrchestrator().then(setOrchestrator, () => setOrchestrator({ available: false, running: false }));
    api.getTracker().then(setTracker, () => undefined);
  }, []);

  async function toggleOrchestrator(running: boolean) {
    setOrchestratorBusy(true);
    setOrchestratorError(null);
    try {
      setOrchestrator(await api.setOrchestrator(running));
    } catch (err) {
      setOrchestratorError(err instanceof Error ? err.message : String(err));
    } finally {
      setOrchestratorBusy(false);
    }
  }

  async function create(input: CreateTaskInput) {
    setCreateError(null);
    try {
      await api.createTask(input);
      load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  return (
    <div className="home">
      <NewTaskForm onCreate={create} error={createError} tracker={tracker} />
      <div>
        <div className="home__heading">
          <h2>Tasks</h2>
          <OrchestratorSwitch state={orchestrator} onToggle={toggleOrchestrator} busy={orchestratorBusy} error={orchestratorError} />
        </div>
        {loadError && <p role="alert" className="error">Couldn't load tasks: {loadError}. Is the API running (pnpm factory:server)?</p>}
        {tasks && <PipelineOverview tasks={tasks} />}
        {tasks ? <TaskTable tasks={tasks} /> : !loadError && <p>Loading…</p>}
      </div>
    </div>
  );
}
