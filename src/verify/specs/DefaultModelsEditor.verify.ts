import { createElement } from "react";
import { z } from "zod";
import { DEFAULT_PHASE_MODELS, KNOWN_MODELS, MODELS, PHASES, PHASE_INFO, PhaseSchema, type PhaseModels } from "../../../shared/models";
import { DefaultModelsEditor, type DefaultModelsEditorProps } from "../../dashboard/components/DefaultModelsEditor";
import { registerUnit } from "../core/registry";

const saved: PhaseModels[] = [];
const record: DefaultModelsEditorProps["onSave"] = (m) => {
  saved.push(m);
};
const value = DEFAULT_PHASE_MODELS;

registerUnit<DefaultModelsEditorProps>({
  id: "DefaultModelsEditor",
  title: "DefaultModelsEditor",
  description: "Edit the factory's default model per pipeline step; saves only the steps that changed.",
  kind: "component",
  render: (props) => {
    saved.length = 0;
    return createElement(DefaultModelsEditor, props);
  },
  propsSchema: z.object({
    value: z.record(PhaseSchema, z.string()),
    onSave: z.function(),
    error: z.string().nullish(),
  }),
  fixtures: [
    { id: "defaults", description: "The built-in defaults: Fable judges, Opus builds. Nothing to save.", props: { value, onSave: record } },
    {
      id: "change-and-save",
      description: "Switch implement to Sonnet and save: only that step is sent.",
      props: { value, onSave: record },
      act: async (ctx) => {
        await ctx.select("#default-model-implementing", MODELS.sonnet);
        await ctx.click("button[type=submit]");
      },
    },
    {
      id: "change-back",
      probe: true,
      description: "Probe: changing a step and changing it back leaves nothing to save.",
      props: { value, onSave: record },
      act: async (ctx) => {
        await ctx.select("#default-model-reviewing", MODELS.haiku);
        await ctx.select("#default-model-reviewing", MODELS.fable);
        await ctx.click("button[type=submit]");
      },
    },
    {
      id: "unknown-model",
      probe: true,
      description: "Probe: a saved default that isn't a known model is still shown and selected.",
      props: { value: { ...value, retro: "claude-custom-1" }, onSave: record },
    },
    { id: "server-error", probe: true, description: "Probe: an API error is shown as an alert.", props: { value, onSave: record, error: "Model must be a Claude model id" } },
  ],
  invariants: [
    {
      id: "select-per-phase",
      description: "One select per phase, in order, with its label and role, offering the known models",
      check: ({ root }) => {
        const rows = Array.from(root.querySelectorAll<HTMLElement>("tbody tr"));
        const bad = PHASES.filter((p, i) => {
          const row = rows[i];
          const options = Array.from(row?.querySelector("select")?.options ?? []).map((o) => o.value);
          return row?.dataset.phase !== p || row.querySelector(".models__label")?.textContent !== PHASE_INFO[p].label || !KNOWN_MODELS.every((m) => options.includes(m));
        });
        return (rows.length === PHASES.length && bad.length === 0) || `rows=${rows.length} bad=${bad.join()}`;
      },
    },
    {
      id: "shows-saved-value",
      description: "Without edits, each select shows the saved default",
      onlyFixtures: ["defaults", "unknown-model", "server-error"],
      check: ({ root, props }) => {
        const bad = PHASES.filter((p) => root.querySelector<HTMLSelectElement>(`#default-model-${p}`)?.value !== props.value[p]);
        return bad.length === 0 || `wrong: ${bad.join()}`;
      },
    },
    {
      id: "save-enabled-iff-changed",
      description: "Save is enabled if and only if a step differs from the saved value",
      check: ({ root, contract }) => {
        const btn = root.querySelector<HTMLButtonElement>("button[type=submit]");
        const changedRows = root.querySelectorAll('tr[data-changed="true"]').length;
        return (btn?.disabled === (changedRows === 0) && contract.changed === String(changedRows)) || `disabled=${btn?.disabled} changed=${changedRows} contract=${contract.changed}`;
      },
    },
    {
      id: "saves-only-changes",
      description: "Saving sends exactly the changed steps",
      onlyFixtures: ["change-and-save"],
      check: () => JSON.stringify(saved) === JSON.stringify([{ implementing: MODELS.sonnet }]) || `saved=${JSON.stringify(saved)}`,
    },
    {
      id: "no-save-without-change",
      description: "Nothing is sent when nothing changed",
      onlyFixtures: ["change-back", "defaults"],
      check: () => saved.length === 0 || `saved=${JSON.stringify(saved)}`,
    },
    {
      id: "error-shown-iff-error",
      description: "An alert is shown if and only if there's an error",
      check: ({ root, props }) => (root.querySelector("[role=alert]")?.textContent ?? null) === (props.error ?? null),
    },
  ],
});
