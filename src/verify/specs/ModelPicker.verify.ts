import { createElement } from "react";
import { z } from "zod";
import { DEFAULT_PHASE_MODELS, KNOWN_MODELS, MODELS, PHASES, PHASE_INFO, PhaseModels, modelFor, type PhaseModels as PhaseModelsT } from "../../../shared/models";
import { ModelPicker, type ModelChange, type ModelPickerProps } from "../../dashboard/components/ModelPicker";
import { registerUnit } from "../core/registry";

const changes: ModelChange[] = [];
const record: ModelPickerProps["onChange"] = (c) => {
  changes.push(c);
};
const defaults = DEFAULT_PHASE_MODELS;
const everyPhase: PhaseModelsT = Object.fromEntries(PHASES.map((p) => [p, MODELS.haiku]));

registerUnit<ModelPickerProps>({
  id: "ModelPicker",
  title: "ModelPicker",
  description: "Per-step model for a task: a select per phase with 'Default (<model>)' or a model; choosing one sets an override, Default clears it.",
  kind: "component",
  render: (props) => {
    changes.length = 0;
    return createElement(ModelPicker, props);
  },
  propsSchema: z.object({
    defaults: PhaseModels,
    overrides: PhaseModels.optional(),
    onChange: z.function(),
    disabled: z.boolean().optional(),
    idPrefix: z.string().optional(),
  }),
  fixtures: [
    { id: "defaults-only", description: "No overrides: every step on the factory default.", props: { defaults, onChange: record } },
    { id: "one-override", description: "Implement overridden to Sonnet.", props: { defaults, overrides: { implementing: MODELS.sonnet }, onChange: record } },
    {
      id: "set-override",
      description: "Choosing Sonnet for review reports an override.",
      props: { defaults, onChange: record },
      act: (ctx) => ctx.select("#phase-model-reviewing", MODELS.sonnet),
    },
    {
      id: "clear-override",
      description: "Choosing Default for an overridden step reports a clear.",
      props: { defaults, overrides: { implementing: MODELS.sonnet }, onChange: record },
      act: (ctx) => ctx.select("#phase-model-implementing", ""),
    },
    { id: "every-phase-overridden", probe: true, description: "Probe: every step overridden.", props: { defaults, overrides: everyPhase, onChange: record } },
    {
      id: "override-equals-default",
      probe: true,
      description: "Probe: an override naming the default model is still an override (it survives a change of default).",
      props: { defaults, overrides: { scoping: MODELS.fable }, onChange: record },
    },
    {
      id: "unknown-model",
      probe: true,
      description: "Probe: an override with a model not in the known list is still shown and selected; edited defaults show in the Default label.",
      props: { defaults: { ...defaults, design: MODELS.haiku }, overrides: { pr: "claude-custom-1" }, onChange: record },
    },
    { id: "disabled", probe: true, description: "Probe: a finished task can't change models.", props: { defaults, onChange: record, disabled: true } },
  ],
  invariants: [
    {
      id: "row-per-phase",
      description: "One row per phase, in order, with its label and role",
      check: ({ root }) => {
        const rows = Array.from(root.querySelectorAll<HTMLElement>("tbody tr")).map((tr) => `${tr.dataset.phase}:${tr.querySelector(".models__label")?.textContent}:${tr.querySelector(".models__role")?.textContent}`);
        const expected = PHASES.map((p) => `${p}:${PHASE_INFO[p].label}:${PHASE_INFO[p].role}`);
        return rows.join() === expected.join() || `rows=${rows.join()}`;
      },
    },
    {
      id: "select-shows-choice",
      description: "Each select offers Default (<default model>) plus the known models, and shows the override or Default",
      check: ({ root, props }) => {
        const bad = PHASES.filter((p) => {
          const select = root.querySelector<HTMLSelectElement>(`tr[data-phase="${p}"] select`);
          if (!select) return true;
          const options = Array.from(select.options);
          const override = props.overrides?.[p];
          return (
            options[0]?.value !== "" ||
            options[0]?.textContent !== `Default (${modelFor(p, props.defaults)})` ||
            !KNOWN_MODELS.every((m) => options.some((o) => o.value === m)) ||
            select.value !== (override ?? "")
          );
        });
        return bad.length === 0 || `wrong selects: ${bad.join()}`;
      },
    },
    {
      id: "resolved-model",
      description: "Each row's resolved model is the override, else the default",
      check: ({ root, props }) => {
        const bad = PHASES.filter((p) => root.querySelector<HTMLElement>(`tr[data-phase="${p}"]`)?.dataset.model !== modelFor(p, props.defaults, props.overrides));
        return bad.length === 0 || `wrong: ${bad.join()}`;
      },
    },
    {
      id: "overrides-marked",
      description: "Exactly the overridden phases are marked, and the contract counts them",
      check: ({ root, props, contract }) => {
        const marked = Array.from(root.querySelectorAll<HTMLElement>("tbody tr"))
          .filter((tr) => tr.dataset.overridden === "true" && tr.querySelector(".models__override"))
          .map((tr) => tr.dataset.phase);
        const tags = root.querySelectorAll(".models__override").length;
        const expected = PHASES.filter((p) => props.overrides?.[p] !== undefined);
        return (marked.join() === expected.join() && tags === expected.length && contract.overridden === String(expected.length)) ||
          `marked=${marked} tags=${tags} expected=${expected} contract=${contract.overridden}`;
      },
    },
    {
      id: "set-reports-override",
      description: "Choosing a model reports {phase, model} once",
      onlyFixtures: ["set-override"],
      check: () => JSON.stringify(changes) === JSON.stringify([{ phase: "reviewing", model: MODELS.sonnet }]) || `changes=${JSON.stringify(changes)}`,
    },
    {
      id: "default-reports-clear",
      description: "Choosing Default reports {phase, model: null} once",
      onlyFixtures: ["clear-override"],
      check: () => JSON.stringify(changes) === JSON.stringify([{ phase: "implementing", model: null }]) || `changes=${JSON.stringify(changes)}`,
    },
    {
      id: "disabled-disables-selects",
      description: "Disabled disables every select",
      onlyFixtures: ["disabled"],
      check: ({ root }) => Array.from(root.querySelectorAll("select")).every((s) => s.matches(":disabled")) || "a select is enabled",
    },
  ],
});
