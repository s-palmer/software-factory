import { createElement } from "react";
import { z } from "zod";
import type { Artifact } from "../../../shared/api";
import { BeforeAfter, type BeforeAfterProps } from "../../dashboard/components/BeforeAfter";
import { registerUnit } from "../core/registry";

const removed: string[] = [];
const copied: string[] = [];
const onRemove = (id: string) => void removed.push(id);
const copyImage = async (url: string) => void copied.push(url);
const failingCopy = async () => {
  throw new Error("clipboard blocked");
};

const pic = (fill: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="${fill}"/></svg>`)}`;
const shot = (id: string, run: string, label: string, createdAt: string, fill = "#cde"): Artifact => ({
  id,
  taskId: "t1",
  kind: "screenshot",
  path: `tasks/t1/${run}/screenshots/${id}.png`,
  url: pic(fill),
  label,
  createdAt,
});

const paired = [
  shot("b1", "r-before", "BEFORE: The drawer has a close button", "2026-11-14T15:02:00", "#eee"),
  shot("a1", "r-after", "AFTER: PASS: The drawer has a close button", "2026-11-14T15:00:00", "#cfe"),
  shot("b2", "r-before", "BEFORE: Escape closes the drawer", "2026-11-14T15:02:01", "#eee"),
  shot("a2", "r-after", "AFTER: FAIL: Escape closes the drawer", "2026-11-14T15:00:01", "#fcc"),
];

registerUnit<BeforeAfterProps>({
  id: "BeforeAfter",
  title: "BeforeAfter",
  description: "The browser check's screenshots side by side: one row per criterion, the base on the left and the change on the right, each with Copy and Remove.",
  kind: "component",
  render: (props) => {
    removed.length = 0;
    copied.length = 0;
    return createElement(BeforeAfter, props);
  },
  propsSchema: z.object({ artifacts: z.array(z.custom<Artifact>()), onRemove: z.function(), copyImage: z.function().optional() }),
  fixtures: [
    { id: "paired", description: "Two criteria with before and after; the failed one comes first.", props: { artifacts: paired, onRemove, copyImage } },
    { id: "copy", description: "Copy puts that picture on the clipboard and says so.", props: { artifacts: paired, onRemove, copyImage }, act: (ctx) => ctx.click('[data-artifact-id="a1"] .evidence__copy') },
    { id: "remove", description: "Remove asks to remove that picture.", props: { artifacts: paired, onRemove, copyImage }, act: (ctx) => ctx.click('[data-artifact-id="b2"] .evidence__remove') },
    { id: "empty", probe: true, description: "Probe: no browser check yet.", props: { artifacts: [], onRemove, copyImage } },
    {
      id: "no-before",
      probe: true,
      description: "Probe: the base did not start, so only after pictures exist.",
      props: { artifacts: paired.filter((a) => a.label.startsWith("AFTER")), onRemove, copyImage },
    },
    {
      id: "older-run",
      probe: true,
      description: "Probe: a failed older attempt is not mixed with the latest one.",
      props: { artifacts: [...paired, shot("old", "r-old", "AFTER: FAIL: The drawer has a close button", "2026-11-14T14:00:00", "#f99")], onRemove, copyImage },
    },
    {
      id: "other-screenshots",
      probe: true,
      description: "Probe: screenshots without a before or after label are left to the gallery.",
      props: { artifacts: [shot("v1", "r-verify", "CartSummary / empty: PASS", "2026-11-14T15:00:00")], onRemove, copyImage },
    },
    {
      id: "copy-fails",
      probe: true,
      description: "Probe: the browser refuses the clipboard; an alert says so.",
      props: { artifacts: paired, onRemove, copyImage: failingCopy },
      act: (ctx) => ctx.click('[data-artifact-id="a1"] .evidence__copy'),
    },
  ],
  invariants: [
    {
      id: "one-row-per-criterion",
      description: "One row per criterion of the latest run, failures first",
      check: ({ root, props }) => {
        const rows = [...root.querySelectorAll(".evidence__row")].map((r) => r.getAttribute("data-pass"));
        const criteria = new Set(props.artifacts.map((a) => /^(?:BEFORE|AFTER): (?:(?:PASS|FAIL): )?(.+)$/.exec(a.label)?.[1]).filter(Boolean));
        if (rows.length !== criteria.size) return `rows=${rows.length} criteria=${criteria.size}`;
        return rows.indexOf("false") <= 0 || `failed row at ${rows.indexOf("false")}`;
      },
    },
    {
      id: "sides-split",
      description: "Before pictures sit in the before column and after pictures in the after column",
      check: ({ root }) => {
        const wrong = [...root.querySelectorAll(".evidence__side")].flatMap((side) =>
          [...side.querySelectorAll("img")].filter((img) => !img.alt.startsWith(side.getAttribute("data-side") === "before" ? "BEFORE" : "AFTER")),
        );
        return wrong.length === 0 || `${wrong.length} picture(s) in the wrong column`;
      },
    },
    {
      id: "latest-run-only",
      description: "A picture from an older run of the same side is not shown",
      onlyFixtures: ["older-run"],
      check: ({ root }) => root.querySelector('[data-artifact-id="old"]') === null || "old run shown",
    },
    {
      id: "every-picture-has-actions",
      description: "Every picture has a Copy and a Remove button",
      check: ({ root }) => [...root.querySelectorAll(".evidence__shot")].every((f) => f.querySelector(".evidence__copy") && f.querySelector(".evidence__remove")) || "missing button",
    },
    { id: "copy-reports", description: "Copy copies the picture's URL once and confirms", onlyFixtures: ["copy"], check: ({ root, props }) => (copied.length === 1 && copied[0] === props.artifacts.find((a) => a.id === "a1")?.url && root.querySelector("[role=status]") !== null) || `copied=${copied.length}` },
    { id: "remove-reports", description: "Remove reports the picture's id once", onlyFixtures: ["remove"], check: () => removed.join() === "b2" || `removed=${removed}` },
    { id: "copy-failure-shown", description: "A refused copy shows an alert", onlyFixtures: ["copy-fails"], check: ({ root }) => root.querySelector("[role=alert]")?.textContent?.includes("clipboard blocked") || "no alert" },
  ],
});
