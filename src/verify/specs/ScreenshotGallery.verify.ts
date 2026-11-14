import { createElement } from "react";
import { z } from "zod";
import { ScreenshotGallery, type ScreenshotGalleryProps } from "../../dashboard/components/ScreenshotGallery";
import { registerUnit } from "../core/registry";
import { shot, shots } from "./fixtures";

registerUnit<ScreenshotGalleryProps>({
  id: "ScreenshotGallery",
  title: "ScreenshotGallery",
  description: "Thumbnails of a task's screenshots; selecting one shows it large and targets feedback at it.",
  kind: "component",
  render: (props) => createElement(ScreenshotGallery, props),
  propsSchema: z.object({
    artifacts: z.array(z.object({ id: z.string(), kind: z.string(), url: z.string(), label: z.string(), path: z.string() }).loose()),
    selectedId: z.string().nullish(),
    onSelect: z.function().optional(),
  }),
  fixtures: [
    { id: "three", description: "Three screenshots, none selected.", props: { artifacts: shots } },
    { id: "preselected", description: "Second screenshot selected and previewed.", props: { artifacts: shots, selectedId: "s2" } },
    {
      id: "click-select",
      description: "Clicking a thumbnail selects it.",
      props: { artifacts: shots },
      act: (ctx) => ctx.click('[data-artifact-id="s3"]'),
    },
    {
      id: "click-deselect",
      probe: true,
      description: "Probe: clicking the selected thumbnail again deselects it.",
      props: { artifacts: shots, selectedId: "s1" },
      act: (ctx) => ctx.click('[data-artifact-id="s1"]'),
    },
    { id: "none", probe: true, description: "Probe: no screenshots shows an empty state.", props: { artifacts: [] } },
    {
      id: "non-screenshots-ignored",
      probe: true,
      description: "Probe: traces and reports are not shown as screenshots; a missing label falls back to the path.",
      props: { artifacts: [{ ...shot("s9", ""), path: "screenshots/unlabelled.png" }, { ...shot("t1", "trace"), kind: "trace" }] },
    },
  ],
  invariants: [
    {
      id: "thumbs-match-count",
      description: "One thumbnail per screenshot",
      check: ({ root, contract, props }) => {
        const thumbs = root.querySelectorAll(".gallery__thumb").length;
        const expected = props.artifacts.filter((a) => a.kind === "screenshot").length;
        return (thumbs === expected && String(expected) === contract.count) || `thumbs=${thumbs} expected=${expected}`;
      },
    },
    {
      id: "images-have-alt",
      description: "Every image has non-empty alt text",
      check: ({ root }) => Array.from(root.querySelectorAll("img")).every((img) => (img.getAttribute("alt") ?? "").trim() !== ""),
    },
    {
      id: "selection-consistent",
      description: "At most one thumbnail is pressed, it matches data-verify-selected, and it is previewed",
      check: ({ root, contract }) => {
        const pressed = Array.from(root.querySelectorAll('[aria-pressed="true"]')).map((b) => b.getAttribute("data-artifact-id"));
        const preview = root.querySelector(".gallery__preview") !== null;
        if (!contract.selected) return (pressed.length === 0 && !preview) || `pressed=${pressed} preview=${preview}`;
        return (pressed.length === 1 && pressed[0] === contract.selected && preview) || `pressed=${pressed} selected=${contract.selected}`;
      },
    },
    { id: "click-selects", description: "Clicked thumbnail is selected", onlyFixtures: ["click-select"], check: ({ contract }) => contract.selected === "s3" },
    { id: "click-deselects", description: "Re-clicking clears the selection", onlyFixtures: ["click-deselect"], check: ({ contract }) => contract.selected === "" },
  ],
});
