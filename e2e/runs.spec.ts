/** Running browser tests from the dashboard, and following a task's progress. */
import { expect, test } from "@playwright/test";

const ARTIFACT_DIR = process.env.ARTIFACT_DIR ?? "artifacts";
const shot = (name: string) => ({ path: `${ARTIFACT_DIR}/screenshots/dashboard--${name}.png`, fullPage: true });

test("start a run, watch it live, then review the results", async ({ page }) => {
  await page.goto("/runs");
  await page.getByRole("button", { name: "▶ Run browser tests" }).click();

  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.locator(".run-page header .run-status")).toHaveText("running");
  await expect(page.locator(".run-log pre")).toContainText("Running 2 tests");
  await page.screenshot(shot("run-live"));

  await expect(page.locator(".run-page header .run-status")).toHaveText("passed", { timeout: 15_000 });
  const results = page.locator('[data-verify-unit="RunResults"]');
  await expect(results).toHaveAttribute("data-verify-count", "2");
  const img = results.locator("img").first();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByRole("link", { name: /Playwright report/ })).toBeVisible();
  await page.screenshot(shot("run-results"));

  await page.getByRole("link", { name: "← All runs" }).click();
  await expect(page.locator('[data-verify-unit="RunTable"]')).toHaveAttribute("data-verify-running", "0");
});

test("a task shows where it is in the pipeline and can run tests that land in its gallery", async ({ page }) => {
  await page.goto("/");
  // The overview and the task table must agree (other tests change task states, so don't assume counts).
  const table = page.locator('[data-verify-unit="TaskTable"]');
  await expect(table).toHaveAttribute("data-verify-count", /\d+/);
  const overview = page.locator('[data-verify-unit="PipelineOverview"]');
  await expect(overview).toHaveAttribute("data-verify-total", (await table.getAttribute("data-verify-count"))!);
  await expect(overview).toHaveAttribute("data-verify-awaiting", (await table.getAttribute("data-verify-awaiting"))!);

  await page.locator("tbody tr", { hasText: "Tidy dashboard spacing" }).getByRole("link").click();
  const progress = page.locator('[data-verify-unit="PipelineProgress"]');
  await expect(progress).toHaveAttribute("data-verify-actor", "agent");
  await expect(progress).toHaveAttribute("data-verify-status", "implementing");
  await expect(page.locator(".pipeline__now")).toContainText("Stage 5 of 10: Implement");
  await expect(page.locator('.pipeline__steps li[aria-current="step"]')).toHaveAttribute("data-status", "implementing");
  await page.screenshot(shot("task-progress"));

  const before = Number(await page.locator('[data-verify-unit="ScreenshotGallery"]').getAttribute("data-verify-count"));
  await page.getByRole("button", { name: "▶ Run browser tests" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.locator(".run-page header .run-status")).toHaveText("passed", { timeout: 15_000 });
  await page.getByRole("link", { name: "this task" }).click();
  // The fake suite produces one explicit screenshot and one per-test screenshot.
  await expect(page.locator('[data-verify-unit="ScreenshotGallery"]')).toHaveAttribute("data-verify-count", String(before + 2));
});
