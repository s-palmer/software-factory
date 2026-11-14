import { createElement } from "react";
import { z } from "zod";
import type { FeedbackInput } from "../../../shared/api";
import { TaskStatusSchema } from "../../../shared/api";
import { FeedbackPanel, type FeedbackPanelProps } from "../../dashboard/components/FeedbackPanel";
import { registerUnit } from "../core/registry";
import { shots } from "./fixtures";

const sent: FeedbackInput[] = [];
const record: FeedbackPanelProps["onSubmit"] = (input) => {
  sent.push(input);
};
const reason = "Implement failed 3 times: the locked test `AC-2 shows the empty state` still fails (expected 'No tasks', got '').";
const escalated: FeedbackPanelProps = {
  status: "escalated",
  context: {
    escalation: reason,
    escalatedFrom: "implementing",
    questions: ["Should the empty state show on the filtered view too?", "Is it fine to change the fixture data in e2e/fixtures?"],
  },
  artifacts: shots,
  onSubmit: record,
};

registerUnit<FeedbackPanelProps>({
  id: "FeedbackPanel",
  title: "FeedbackPanel",
  description: "For escalated tasks: the reason and open questions, with Retry stage / Request changes. Comments are always possible.",
  kind: "component",
  render: (props) => {
    sent.length = 0;
    return createElement(FeedbackPanel, props);
  },
  propsSchema: z.object({
    status: TaskStatusSchema,
    context: z.object({ escalation: z.string().optional(), questions: z.array(z.string()).optional(), escalatedFrom: TaskStatusSchema.optional() }).optional(),
    artifacts: z.array(z.object({ id: z.string(), kind: z.string() }).loose()),
    selectedArtifactId: z.string().nullish(),
    onSubmit: z.function(),
    error: z.string().nullish(),
  }),
  fixtures: [
    { id: "escalated", description: "Escalated: the reason word for word, the questions as a list; Retry is enabled, Request changes needs a comment.", props: escalated },
    {
      id: "retry",
      description: "Retry the stage without a comment.",
      props: escalated,
      act: (ctx) => ctx.click(".approve"),
    },
    {
      id: "request-changes",
      description: "Type a comment about a screenshot and request changes.",
      props: { ...escalated, selectedArtifactId: "s2" },
      act: async (ctx) => {
        await ctx.type("#feedback-comment", "  Button overlaps the title  ");
        await ctx.click(".request-changes");
      },
    },
    {
      id: "not-escalated",
      probe: true,
      description: "Probe: a task mid-pipeline offers Comment only, and no decision card, even with stale escalation context.",
      props: { ...escalated, status: "implementing" },
    },
    {
      id: "escalated-no-reason",
      probe: true,
      description: "Probe: escalated with no reason or questions recorded still offers the decision.",
      props: { ...escalated, context: {} },
    },
    {
      id: "whitespace-comment",
      probe: true,
      description: "Probe: a whitespace-only comment can't request changes.",
      props: escalated,
      act: (ctx) => ctx.type("#feedback-comment", "   "),
    },
    {
      id: "no-screenshots",
      probe: true,
      description: "Probe: no screenshot picker when there are no screenshots.",
      props: { ...escalated, artifacts: [] },
    },
    { id: "server-error", probe: true, description: "Probe: an API error is shown as an alert.", props: { ...escalated, error: "Only escalated tasks take a decision" } },
  ],
  invariants: [
    {
      id: "decisions-iff-escalated",
      description: "The decision card, Retry stage and Request changes appear if and only if the task is escalated",
      check: ({ root, props, contract }) => {
        const approve = root.querySelector(".approve");
        const shown = root.querySelector(".decision") !== null && approve?.textContent === "Retry stage" && root.querySelector(".request-changes") !== null;
        const none = !root.querySelector(".decision, .approve, .request-changes");
        const isEscalated = props.status === "escalated";
        return (contract.escalated === String(isEscalated) && (isEscalated ? shown : none)) || `shown=${shown} none=${none} escalated=${contract.escalated}`;
      },
    },
    {
      id: "reason-word-for-word",
      description: "The escalation reason is shown exactly as recorded (a placeholder when there is none)",
      check: ({ root, props }) => {
        if (props.status !== "escalated") return true;
        const text = root.querySelector(".decision__reason")?.textContent;
        return props.context?.escalation ? text === props.context.escalation || `text=${text}` : root.querySelector(".decision__reason--missing") !== null;
      },
    },
    {
      id: "questions-as-list",
      description: "Each open question is one list item, in order; no list when there are none",
      check: ({ root, props, contract }) => {
        const items = Array.from(root.querySelectorAll(".decision__questions li")).map((li) => li.textContent);
        const expected = props.status === "escalated" ? (props.context?.questions ?? []) : [];
        const listShown = root.querySelector(".decision__questions") !== null;
        return (JSON.stringify(items) === JSON.stringify(expected) && listShown === expected.length > 0 && (props.status !== "escalated" || contract.questions === String(expected.length))) ||
          `items=${JSON.stringify(items)}`;
      },
    },
    {
      id: "comment-always-available",
      description: "The comment box and Comment button are there whatever the status",
      check: ({ root }) => (root.querySelector("#feedback-comment") !== null && root.querySelector(".comment") !== null) || "comment controls missing",
    },
    {
      id: "comment-required",
      description: "Request changes and Comment are disabled if and only if the comment is blank",
      check: ({ root, contract }) => {
        const blank = contract["has-comment"] !== "true";
        const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>(".request-changes, .comment"));
        return buttons.every((b) => b.disabled === blank) || `blank=${blank} disabled=${buttons.map((b) => b.disabled)}`;
      },
    },
    {
      id: "picker-iff-screenshots",
      description: "Screenshot picker shown if and only if there are screenshots",
      check: ({ root, props }) => (root.querySelector("#feedback-artifact") !== null) === props.artifacts.some((a) => a.kind === "screenshot"),
    },
    {
      id: "retry-sent",
      description: "Retry stage sends approve once, with an empty comment",
      onlyFixtures: ["retry"],
      check: () => (sent.length === 1 && sent[0]?.decision === "approve" && sent[0].comment === "") || `sent=${JSON.stringify(sent)}`,
    },
    {
      id: "request-changes-sent",
      description: "Sends trimmed comment with the selected screenshot, then clears",
      onlyFixtures: ["request-changes"],
      check: ({ root }) => {
        const [s] = sent;
        const value = root.querySelector<HTMLTextAreaElement>("#feedback-comment")?.value;
        return (sent.length === 1 && s?.decision === "request_changes" && s.comment === "Button overlaps the title" && s.artifactId === "s2" && value === "") ||
          `sent=${JSON.stringify(sent)} value="${value}"`;
      },
    },
    {
      id: "error-shown-iff-error",
      description: "An alert is shown if and only if there's an error",
      check: ({ root, props }) => (root.querySelector("[role=alert]")?.textContent ?? null) === (props.error ?? null),
    },
  ],
});
