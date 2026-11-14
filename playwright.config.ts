import { defineConfig, devices } from "@playwright/test";

/** Everything the browser verifier produces lands here so the orchestrator can index it. */
const ARTIFACT_DIR = process.env.ARTIFACT_DIR ?? "artifacts";

export default defineConfig({
  testDir: "e2e",
  outputDir: `${ARTIFACT_DIR}/test-results`,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ["list"],
    ["json", { outputFile: `${ARTIFACT_DIR}/e2e-report.json` }],
    ["html", { outputFolder: `${ARTIFACT_DIR}/playwright-report`, open: "never" }],
  ],
  use: {
    baseURL: "http://localhost:4173",
    headless: true,
    screenshot: "on",
    // Dashboard-triggered runs set these to "on" so every session can be watched afterwards.
    trace: (process.env.PW_TRACE as "on" | undefined) ?? "retain-on-failure",
    video: (process.env.PW_VIDEO as "on" | undefined) ?? "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // A throwaway API + DB on a separate port, seeded with fixture screenshots, so e2e never touches your dev data.
  webServer: [
    {
      command: "tsx server/seed.ts --reset && tsx server/index.ts",
      url: "http://127.0.0.1:8788/api/tasks",
      env: {
        FACTORY_DB: `${ARTIFACT_DIR}/e2e/factory.duckdb`,
        FACTORY_ARTIFACTS: "e2e/fixtures/artifacts",
        API_PORT: "8788",
        // The dashboard's "Run browser tests" button runs a fake suite here; the real one can't run inside itself.
        FACTORY_TEST_COMMAND: "node e2e/fixtures/fake-playwright.mjs",
        FAKE_DELAY_MS: "1500",
      },
      reuseExistingServer: false,
    },
    {
      command: "pnpm build && pnpm preview",
      url: "http://localhost:4173",
      env: { API_PORT: "8788" },
      reuseExistingServer: false,
    },
  ],
  // One worker: the e2e tests share one seeded database.
  workers: 1,
});
