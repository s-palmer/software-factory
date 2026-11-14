// Stand-in for `playwright test`, used by the API tests and the dashboard e2e test (running the real
// suite from inside the suite would fight over ports). Writes a Playwright-shaped JSON report into
// $ARTIFACT_DIR. FAKE_OUTCOME=fail makes one test fail; FAKE_OUTCOME=crash exits without a report.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.env.ARTIFACT_DIR;
const outcome = process.env.FAKE_OUTCOME ?? "pass";
const here = dirname(fileURLToPath(import.meta.url));
const delay = Number(process.env.FAKE_DELAY_MS ?? 300);

console.log("Running 2 tests using 1 worker (fake)");
await new Promise((r) => setTimeout(r, delay));
if (outcome === "crash") {
  console.error("Error: browser failed to launch (fake)");
  process.exit(2);
}

mkdirSync(join(dir, "screenshots"), { recursive: true });
mkdirSync(join(dir, "test-results/a"), { recursive: true });
copyFileSync(join(here, "artifacts/screenshots/after.png"), join(dir, "screenshots/dashboard--home.png"));
copyFileSync(join(here, "artifacts/screenshots/before.png"), join(dir, "test-results/a/test-finished-1.png"));
mkdirSync(join(dir, "playwright-report"), { recursive: true });
writeFileSync(join(dir, "playwright-report/index.html"), "<!doctype html><title>Fake report</title><h1>Fake Playwright report</h1>");

const failed = outcome === "fail";
const report = {
  stats: { expected: failed ? 1 : 2, unexpected: failed ? 1 : 0, flaky: 0, skipped: 0, duration: 1234.5 },
  suites: [
    {
      title: "dashboard.spec.ts",
      file: "dashboard.spec.ts",
      specs: [
        {
          title: "create a task from the dashboard",
          file: "dashboard.spec.ts",
          tests: [{ status: "expected", results: [{ status: "passed", duration: 600, attachments: [{ name: "screenshot", contentType: "image/png", path: resolve(dir, "test-results/a/test-finished-1.png") }] }] }],
        },
        {
          title: "review screenshots",
          file: "dashboard.spec.ts",
          tests: [
            {
              status: failed ? "unexpected" : "expected",
              results: [{ status: failed ? "failed" : "passed", duration: 634, attachments: [], ...(failed ? { error: { message: "\u001b[31mExpected: \"implementing\"\u001b[39m\nReceived: \"backlog\"" } } : {}) }],
            },
          ],
        },
      ],
    },
  ],
};
writeFileSync(join(dir, "e2e-report.json"), JSON.stringify(report, null, 2));
console.log(failed ? "  1 failed\n  1 passed" : "  2 passed");
process.exit(failed ? 1 : 0);
