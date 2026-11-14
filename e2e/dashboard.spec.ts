/** The human loop: give the factory a task, decide on an escalated task, pick per-step models, watch agent runs. */
import { expect, test } from "@playwright/test";
import { PHASES } from "../shared/models";

const ARTIFACT_DIR = process.env.ARTIFACT_DIR ?? "artifacts";
const shot = (name: string) => ({ path: `${ARTIFACT_DIR}/screenshots/dashboard--${name}.png`, fullPage: true });

test("create a task from the dashboard", async ({ page }) => {
  await page.goto("/");
  const table = page.locator('[data-verify-unit="TaskTable"]');
  await expect(table).toHaveAttribute("data-verify-count", /\d+/);
  const before = Number(await table.getAttribute("data-verify-count"));
  // The seeded e2e server has no orchestrator loop or has one; either way the switch says which.
  await expect(page.locator(".orchestrator__state")).toHaveText(/^(on|off|not available)$/);
  await page.screenshot(shot("home"));

  // A seeded task waits for its blocker, shown by ticket key.
  const seededBlocked = table.locator("tbody tr").filter({ has: page.locator(".task-table__ticket", { hasText: /^#2$/ }) });
  await expect(seededBlocked.locator(".waiting-for")).toHaveText("waiting for #3");

  // Only an issue number: "99" is normalised to "#99"; blockers "3, #4 3" to ["#3", "#4"].
  const issue = page.getByLabel("GitHub issue");
  const blockedBy = page.getByLabel("Blocked by (optional)");
  const add = page.getByRole("button", { name: "Add task" });
  await expect(add).toBeDisabled();
  await issue.fill("abc");
  await expect(page.locator(".field-error")).toHaveText("Enter an issue number, like 12 or #12.");
  await expect(add).toBeDisabled();
  await issue.fill(" 99 ");
  await blockedBy.fill("3, #4 3");
  await expect(page.locator('[data-verify-unit="NewTaskForm"]')).toHaveAttribute("data-verify-blocked-by", "#3 #4");
  await add.click();

  await expect(table).toHaveAttribute("data-verify-count", String(before + 1));
  const row = table.locator("tbody tr").filter({ has: page.locator(".task-table__ticket", { hasText: /^#99$/ }) });
  await expect(row.locator(".task-table__title > a")).toHaveText("#99");
  await expect(row.locator(".status-badge")).toHaveText("backlog");
  await expect(row.locator(".task-table__attempts")).toHaveText("0");
  await expect(row.locator(".task-table__cost")).toHaveText("$0.00");
  // #4 is done, so only #3 is still in the way.
  await expect(row.locator(".waiting-for")).toHaveText("waiting for #3");
  // The form clears.
  await expect(issue).toHaveValue("");
  await expect(blockedBy).toHaveValue("");

  const created = (await (await page.request.get("/api/tasks")).json()) as Array<{ ticketKey: string; title: string; blockedBy: string[]; ready: boolean }>;
  expect(created.find((t) => t.ticketKey === "#99")).toMatchObject({ title: "#99", ready: false });
  expect(created.find((t) => t.ticketKey === "#99")?.blockedBy).toHaveLength(2);

  // The API's errors are shown: a second task for the same issue, and an unknown blocker.
  await issue.fill("#99");
  await add.click();
  await expect(page.getByRole("alert")).toContainText("Ticket #99 already has task");
  await expect(issue).toHaveValue("#99");
  await issue.fill("100");
  await blockedBy.fill("999");
  await add.click();
  await expect(page.getByRole("alert")).toContainText("Unknown blocker #999");
  await expect(table).toHaveAttribute("data-verify-count", String(before + 1));
});

test("a blocked task says what it waits for on its page", async ({ page }) => {
  await page.goto("/");
  await page.locator("tbody tr").filter({ has: page.locator(".task-table__ticket", { hasText: /^#2$/ }) }).locator(".task-table__title > a").click();
  await expect(page.locator(".task-page__blocked .waiting-for")).toHaveText("waiting for #3");
  await page.locator(".task-page__blocked .waiting-for a").click();
  await expect(page.locator("h1")).toContainText("Tidy dashboard spacing");
});

test("an escalated task shows why, and requesting changes on a screenshot sends it back to implement", async ({ page }) => {
  await page.goto("/");
  await page.locator("tbody tr", { hasText: "Demo: verify the task board" }).getByRole("link").click();

  const panel = page.locator('[data-verify-unit="FeedbackPanel"]');
  await expect(panel).toHaveAttribute("data-verify-escalated", "true");
  await expect(panel.locator(".decision__reason")).toHaveText(
    "Implement failed 3 times: the locked test 'AC-2 empty board shows a hint' still fails (expected 'No tasks yet', got '').",
  );
  await expect(panel.locator(".decision__questions li")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Retry stage" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Request changes" })).toBeDisabled();
  await expect(page.locator(".task-notes__reasons li")).toHaveText(["Changes the browser tests that judge the work"]);

  const gallery = page.locator('[data-verify-unit="ScreenshotGallery"]');
  await expect(gallery).toHaveAttribute("data-verify-count", "2");
  // Fixture screenshots are served by the API from e2e/fixtures/artifacts.
  const firstImg = gallery.locator(".gallery__thumb img").first();
  await expect.poll(() => firstImg.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

  await gallery.getByRole("button", { name: "after" }).click();
  await expect(gallery).toHaveAttribute("data-verify-selected", /.+/);
  await expect(page.getByLabel("About screenshot")).not.toHaveValue("");
  await page.screenshot(shot("task-escalated"));

  await page.getByLabel("Comment").fill("The Add button is greyed out even with text typed");
  await page.getByRole("button", { name: "Request changes" }).click();

  await expect(page.locator("header .status-badge")).toHaveText("implementing");
  await expect(page.locator(".history__feedback").last()).toContainText("Requested changes on after");
  await expect(page.locator(".history__event").last()).toContainText("escalated → implementing");
  // No longer escalated: no decision card, only Comment is offered.
  await expect(page.getByRole("button", { name: "Retry stage" })).toHaveCount(0);
  await expect(panel.locator(".decision")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Comment", exact: true })).toBeVisible();
  await page.screenshot(shot("task-after-feedback"));

  // The comment goes to the implement phase as feedback; it is not saved as a learning.
  const detail = await (await page.request.get(`/api/tasks/${encodeURIComponent(page.url().split("/").pop() ?? "")}`)).json();
  expect(detail.task.context.feedback).toContain("A person asked for changes: The Add button is greyed out even with text typed");
});

test("a task in implement lists its agent runs and decisions, and each step's model can be overridden", async ({ page }) => {
  await page.goto("/");
  await page.locator("tbody tr", { hasText: "Tidy dashboard spacing" }).getByRole("link").click();

  const runs = page.locator('[data-verify-unit="AgentRunList"]');
  // Seeded: 6 runs through the tests stage, then implement attempt 1 and its failed gate. All finished.
  await expect(runs).toHaveAttribute("data-verify-count", "8");
  await expect(runs).toHaveAttribute("data-verify-running", "0");
  // Newest first.
  const started = await runs.locator(".agent-run").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.started ?? ""));
  expect(started).toEqual([...started].sort().reverse());
  // The implement agent ran on the task's override.
  const implement = runs
    .locator(".agent-run")
    .filter({ has: page.locator(".agent-run__stage", { hasText: /^implementing$/ }) })
    .filter({ has: page.locator(".agent-run__kind", { hasText: /^agent$/ }) });
  await expect(implement.locator(".agent-run__model")).toHaveText("claude-sonnet-5-5");
  await expect(runs.locator('.agent-run[data-status="failed"] .agent-run__summary')).toHaveText("Lint failed: unused selector .home__gutter.");
  await expect(page.locator(".task-notes__decision")).toHaveCount(1);
  await expect(page.locator('[data-verify-unit="FeedbackPanel"] .decision')).toHaveCount(0);

  // Seeded with one override: implement on Sonnet.
  const picker = page.locator('[data-verify-unit="ModelPicker"]');
  await expect(picker).toHaveAttribute("data-verify-overridden", "1");
  await expect(picker.locator('tr[data-phase="implementing"]')).toHaveAttribute("data-model", "claude-sonnet-5-5");

  // Override review.
  await picker.locator("#task-model-reviewing").selectOption("claude-haiku-5-5");
  await expect(picker).toHaveAttribute("data-verify-overridden", "2");
  await expect(picker.locator('tr[data-phase="reviewing"]')).toHaveAttribute("data-model", "claude-haiku-5-5");
  await expect(page.locator('.history__event[data-type="models_changed"]').last()).toContainText("Models: reviewing → claude-haiku-5-5");

  // Put implement back on the factory default.
  const defaults = (await (await page.request.get("/api/models")).json()) as { phaseModels: Record<string, string> };
  await picker.locator("#task-model-implementing").selectOption("");
  await expect(picker).toHaveAttribute("data-verify-overridden", "1");
  await expect(picker.locator('tr[data-phase="implementing"]')).toHaveAttribute("data-model", defaults.phaseModels.implementing!);
  await expect(page.locator('.history__event[data-type="models_changed"]').last()).toContainText("Models: cleared implementing");
  await page.screenshot(shot("task-implementing"));

  // Saved on the server.
  await page.reload();
  await expect(picker.locator("#task-model-reviewing")).toHaveValue("claude-haiku-5-5");
  await expect(picker.locator("#task-model-implementing")).toHaveValue("");
});

test("change a factory default model on the Models page; tasks without an override follow it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Models", exact: true }).click();
  await expect(page).toHaveURL(/\/models$/);

  const editor = page.locator('[data-verify-unit="DefaultModelsEditor"]');
  await expect(editor.locator("tbody tr")).toHaveCount(PHASES.length);
  await expect(editor.locator("#default-model-retro")).toHaveValue("claude-fable-5-2");
  await expect(editor.getByRole("button", { name: "Save defaults" })).toBeDisabled();

  await editor.locator("#default-model-retro").selectOption("claude-sonnet-5-5");
  await expect(editor).toHaveAttribute("data-verify-changed", "1");
  await editor.getByRole("button", { name: "Save defaults" }).click();
  await expect(page.locator(".models-page__saved")).toHaveText("Saved 1 step(s).");
  await expect(editor).toHaveAttribute("data-verify-changed", "0");
  await page.screenshot(shot("models"));

  await page.reload();
  await expect(editor.locator("#default-model-retro")).toHaveValue("claude-sonnet-5-5");
  const saved = await (await page.request.get("/api/models")).json();
  expect(saved.phaseModels.retro).toBe("claude-sonnet-5-5");

  // A task without a retro override now resolves to the new default.
  await page.goto("/");
  await page.locator("tbody tr", { hasText: "Document the factory CLI" }).getByRole("link").click();
  const picker = page.locator('[data-verify-unit="ModelPicker"]');
  await expect(picker.locator('tr[data-phase="retro"]')).toHaveAttribute("data-model", "claude-sonnet-5-5");
  await expect(picker.locator("#task-model-retro option").first()).toHaveText("Default (claude-sonnet-5-5)");
});
