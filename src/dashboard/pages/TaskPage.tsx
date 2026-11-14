import { useCallback, useEffect, useState } from "react";
import type { FeedbackInput, TaskDetail, TaskSummary } from "../../../shared/api";
import { DEFAULT_PHASE_MODELS, PHASES, type PhaseModels } from "../../../shared/models";
import { api } from "../api";
import { AgentRunList } from "../components/AgentRunList";
import { FeedbackPanel } from "../components/FeedbackPanel";
import { ModelPicker, type ModelChange } from "../components/ModelPicker";
import { PipelineProgress } from "../components/PipelineProgress";
import { isEvidence } from "../../../shared/evidence";
import { BeforeAfter } from "../components/BeforeAfter";
import { ScreenshotGallery } from "../components/ScreenshotGallery";
import { StatusBadge } from "../components/StatusBadge";
import { formatCost } from "../components/TaskTable";
import { TaskNotes } from "../components/TaskNotes";
import { WaitingFor } from "../components/WaitingFor";
import { formatFull, formatWhen } from "../time";

const DECISION_LABEL = { approve: "Retried the stage", request_changes: "Requested changes", comment: "Commented" } as const;

/** "implementing → claude-sonnet-5-5, cleared reviewing" from a models_changed event's before/after overrides. */
export function describeModelChange(from: unknown, to: unknown): string {
  const before = (from ?? {}) as Record<string, unknown>;
  const after = (to ?? {}) as Record<string, unknown>;
  const parts = PHASES.flatMap((p) => {
    if (after[p] !== undefined && after[p] !== before[p]) return [`${p} → ${String(after[p])}`];
    if (after[p] === undefined && before[p] !== undefined) return [`cleared ${p}`];
    return [];
  });
  return parts.length > 0 ? parts.join(", ") : "no change";
}

export function TaskPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  /** Shown immediately on change; cleared once saved (or rolled back on error). */
  const [pendingOverrides, setPendingOverrides] = useState<PhaseModels | null>(null);
  /** All tasks, to show blockers by ticket key. */
  const [allTasks, setAllTasks] = useState<TaskSummary[]>([]);
  const [defaults, setDefaults] = useState<PhaseModels>(DEFAULT_PHASE_MODELS);
  const [stepping, setStepping] = useState(false);
  const [stepNote, setStepNote] = useState<string | null>(null);

  const load = useCallback(() => {
    api.getTask(id).then(setDetail, (err: unknown) => setLoadError(err instanceof Error ? err.message : String(err)));
    api.listTasks().then(setAllTasks, () => setAllTasks([]));
  }, [id]);
  useEffect(load, [load]);
  useEffect(() => {
    // If the defaults can't be loaded, show the built-in ones.
    api.getDefaultModels().then((d) => setDefaults(d.phaseModels), () => setDefaults(DEFAULT_PHASE_MODELS));
  }, []);

  async function changeModel({ phase, model }: ModelChange) {
    const current: PhaseModels = { ...detail?.task.phaseModels };
    if (model === null) delete current[phase];
    else current[phase] = model;
    setPendingOverrides(current);
    setModelsError(null);
    try {
      const updated = await api.setModels(id, model === null ? { clear: [phase] } : { phaseModels: { [phase]: model } });
      setDetail((d) => (d ? { ...d, task: updated } : d));
      load(); // refresh history
    } catch (err) {
      setModelsError(`Couldn't change models: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPendingOverrides(null);
    }
  }

  async function step() {
    setStepping(true);
    setStepNote(null);
    try {
      await api.stepTask(id);
      setStepNote("Started the next step.");
      load();
    } catch (err) {
      setStepNote(`Couldn't start the next step: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setStepping(false);
    }
  }

  async function removeArtifact(artifactId: string) {
    if (!window.confirm("Remove this screenshot from the task? This deletes the file.")) return;
    await api.removeArtifact(artifactId);
    load();
  }

  async function sendFeedback(input: FeedbackInput) {
    setFeedbackError(null);
    try {
      await api.sendFeedback(id, input);
      load();
    } catch (err) {
      setFeedbackError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  if (loadError) return <p role="alert" className="error">{loadError}</p>;
  if (!detail) return <p>Loading…</p>;

  const { task, agentRuns, artifacts, feedback, events } = detail;
  const overrides = pendingOverrides ?? task.phaseModels;
  const artifactLabel = (artifactId: string | null) => artifacts.find((a) => a.id === artifactId)?.label;

  return (
    <article className="task-page">
      <a href="/">← All tasks</a>
      <header>
        <h1>
          {task.ticketKey && <span className="task-page__ticket">{task.ticketKey}</span>}
          {task.title}
        </h1>
        <StatusBadge status={task.status} />
        <button type="button" className="step" onClick={step} disabled={stepping || task.status === "done"}>
          {stepping ? "Starting…" : "Run next step"}
        </button>
        {task.prUrl && (
          <a className="button task-page__open-pr" href={task.prUrl} target="_blank" rel="noreferrer">
            Open pull request #{task.prNumber}
          </a>
        )}
      </header>
      <p className="task-page__facts">
        Attempts: <strong>{task.attempts}</strong> · Cost: <strong>{formatCost(task.costUsd)}</strong>
        {task.branch && (
          <>
            {" "}· Branch: <code>{task.branch}</code>
          </>
        )}
        {task.prNumber !== null && (
          <>
            {" "}· PR{" "}
            {task.prUrl ? (
              <a href={task.prUrl} target="_blank" rel="noreferrer">
                <strong>#{task.prNumber}</strong>
              </a>
            ) : (
              <strong>#{task.prNumber}</strong>
            )}
          </>
        )}
      </p>
      {!task.ready && task.blockedBy.length > 0 && (
        <p className="task-page__blocked">
          <WaitingFor blockedBy={task.blockedBy} tasks={allTasks} />
        </p>
      )}
      {stepNote && <p className="task-page__step-note" role="status">{stepNote}</p>}
      <PipelineProgress status={task.status} needsBrowser={task.context.needsBrowser} />
      {task.description && <p className="task-page__description">{task.description}</p>}
      <TaskNotes context={task.context} />
      <div className="task-page__body">
        <div>
          <BeforeAfter artifacts={artifacts} onRemove={removeArtifact} />
          <ScreenshotGallery artifacts={artifacts.filter((a) => !isEvidence(a))} selectedId={selected} onSelect={setSelected} />
          <AgentRunList runs={agentRuns} />
        </div>
        <aside>
          <FeedbackPanel status={task.status} context={task.context} artifacts={artifacts} selectedArtifactId={selected} onSubmit={sendFeedback} error={feedbackError} />
          <section className="models-panel">
            <ModelPicker defaults={defaults} overrides={overrides} onChange={changeModel} disabled={pendingOverrides !== null || task.status === "done"} idPrefix="task-model" />
            {modelsError && <p role="alert" className="error">{modelsError}</p>}
          </section>
          <section className="history">
            <h2>History</h2>
            <ol>
              {feedback.map((f) => (
                <li key={f.id} className="history__feedback" data-decision={f.decision}>
                  <strong>{DECISION_LABEL[f.decision]}</strong>
                  {f.artifactId && <> on <em>{artifactLabel(f.artifactId) ?? "a screenshot"}</em></>}
                  {f.comment && <>: “{f.comment}”</>} <time dateTime={f.createdAt} title={formatFull(f.createdAt)}>{formatWhen(f.createdAt)}</time>
                </li>
              ))}
              {events
                .filter((e) => e.type === "status_changed" || e.type === "models_changed")
                .map((e) => (
                  <li key={`e${e.id}`} className="history__event" data-type={e.type}>
                    {e.type === "models_changed"
                      ? `Models: ${describeModelChange(e.payload.from, e.payload.to)}`
                      : `Moved ${String(e.payload.from).replaceAll("_", " ")} → ${String(e.payload.to).replaceAll("_", " ")}`}{" "}
                    <time dateTime={e.ts} title={formatFull(e.ts)}>{formatWhen(e.ts)}</time>
                  </li>
                ))}
            </ol>
          </section>
        </aside>
      </div>
    </article>
  );
}
