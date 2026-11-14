/**
 * Which model runs each phase. Every step of the pipeline is its own agent with its own model:
 * judgement phases (scoping, design, review, the decider, the retro) run on Fable,
 * building phases (tests, implement, browser check, PR text) on Opus.
 *
 * The factory keeps one default per phase (saved, editable); a task can override single phases.
 */
import { z } from "zod";

export const PHASES = ["planning", "scoping", "design", "test_writing", "implementing", "reviewing", "browser_check", "pr", "decider", "retro", "conductor"] as const;
export type Phase = (typeof PHASES)[number];

export const MODELS = {
  fable: "claude-fable-5-2",
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
} as const;

/** The models offered in pickers. Any Claude model id is accepted. */
export const KNOWN_MODELS: readonly string[] = Object.values(MODELS);

export const PHASE_INFO: Record<Phase, { label: string; role: "judgement" | "building" }> = {
  planning: { label: "Plan (PM)", role: "judgement" },
  scoping: { label: "Scope", role: "judgement" },
  design: { label: "Design", role: "judgement" },
  test_writing: { label: "Tests", role: "building" },
  implementing: { label: "Implement", role: "building" },
  reviewing: { label: "Review", role: "judgement" },
  browser_check: { label: "Browser check", role: "building" },
  pr: { label: "PR text", role: "building" },
  decider: { label: "Decider", role: "judgement" },
  retro: { label: "Retro", role: "judgement" },
  conductor: { label: "Conductor", role: "judgement" },
};

export const DEFAULT_PHASE_MODELS: Record<Phase, string> = {
  planning: MODELS.fable,
  scoping: MODELS.fable,
  design: MODELS.fable,
  test_writing: MODELS.opus,
  implementing: MODELS.opus,
  reviewing: MODELS.fable,
  browser_check: MODELS.opus,
  pr: MODELS.opus,
  decider: MODELS.fable,
  retro: MODELS.fable,
  conductor: MODELS.fable,
};

export const ModelId = z.string().regex(/^claude-[a-z0-9.-]+$/, 'Model must be a Claude model id, e.g. "claude-opus-5-5"');
export const PhaseSchema = z.enum(PHASES);
export const PhaseModels = z.partialRecord(PhaseSchema, ModelId);
export type PhaseModels = z.infer<typeof PhaseModels>;

/** The model for one phase of a task: the task's override, else the factory default. */
export function modelFor(phase: Phase, defaults: PhaseModels, overrides: PhaseModels = {}): string {
  return overrides[phase] ?? defaults[phase] ?? DEFAULT_PHASE_MODELS[phase];
}

/** The model of every phase for a task, for display. */
export function modelPlan(defaults: PhaseModels, overrides: PhaseModels = {}): Record<Phase, string> {
  return Object.fromEntries(PHASES.map((p) => [p, modelFor(p, defaults, overrides)])) as Record<Phase, string>;
}
