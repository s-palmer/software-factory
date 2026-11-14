/**
 * Browser verification: discover every unit × fixture from window.__verify, open each
 * isolated route in headless Chromium, assert the verdict, and save a clean screenshot.
 */
import { expect, test } from "@playwright/test";
import type { VerifyManifestEntry, VerifyResult } from "../src/verify/core/types";

const ARTIFACT_DIR = process.env.ARTIFACT_DIR ?? "artifacts";

test("every unit × fixture passes in a real browser", async ({ page }) => {
  await page.goto("/verify");
  const manifest = await page.evaluate(() => window.__verify?.manifest() ?? []);
  expect(manifest.length).toBeGreaterThan(0);

  for (const unit of manifest as VerifyManifestEntry[]) {
    for (const fixture of unit.fixtures) {
      await test.step(`${unit.unitId} / ${fixture.id}`, async () => {
        await page.goto(`${fixture.route}?chrome=0`);
        await page.waitForSelector("body[data-verify-verdict]");
        const result = (await page.evaluate(() => window.__verify?.current())) as VerifyResult;
        await page.screenshot({
          path: `${ARTIFACT_DIR}/screenshots/${unit.unitId}--${fixture.id}.png`,
          fullPage: true,
        });
        expect.soft(result.verdict, JSON.stringify(result.checks.filter((c) => c.status === "fail"), null, 2)).toBe("PASS");
      });
    }
  }
});

test("window.__verify.runAll() agrees in the browser", async ({ page }) => {
  await page.goto("/verify");
  const results = (await page.evaluate(() => window.__verify?.runAll())) as VerifyResult[];
  const notPassing = results.filter((r) => r.verdict !== "PASS");
  expect(notPassing, JSON.stringify(notPassing, null, 2)).toEqual([]);
});
