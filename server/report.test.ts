// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseReport, relativeToRoot } from "./report";

describe("relativeToRoot", () => {
  it("keeps paths inside the root and drops ones outside", () => {
    expect(relativeToRoot("/a/root", "/a/root/runs/x/v.webm")).toBe("runs/x/v.webm");
    expect(relativeToRoot("/a/root", "runs/x.png")).toBe("runs/x.png");
    expect(relativeToRoot("/a/root", "/etc/passwd")).toBeNull();
    expect(relativeToRoot("/a/root", "/a/root/../secret")).toBeNull();
    expect(relativeToRoot("/a/root", "/a/root")).toBeNull();
  });
});

describe("parseReport", () => {
  it("flattens nested describes, classifies attachments, and maps statuses", () => {
    const { results, summary } = parseReport(
      {
        stats: { expected: 1, unexpected: 0, flaky: 1, skipped: 1, duration: 99.6 },
        suites: [
          {
            title: "a.spec.ts",
            file: "a.spec.ts",
            specs: [],
            suites: [
              {
                title: "group",
                file: "a.spec.ts",
                specs: [
                  {
                    title: "retries then passes",
                    file: "a.spec.ts",
                    tests: [
                      {
                        status: "flaky",
                        results: [
                          { status: "failed", duration: 10 },
                          {
                            status: "passed",
                            duration: 20,
                            attachments: [
                              { name: "video", contentType: "video/webm", path: "/r/runs/1/v.webm" },
                              { name: "trace", contentType: "application/zip", path: "/r/runs/1/trace.zip" },
                              { name: "screenshot", contentType: "image/png", path: "/elsewhere/x.png" },
                              { name: "stdout", contentType: "text/plain" },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                  { title: "skipped one", file: "a.spec.ts", tests: [{ status: "skipped", results: [] }] },
                ],
              },
            ],
          },
        ],
      },
      "/r",
    );
    expect(summary).toEqual({ passed: 1, failed: 0, flaky: 1, skipped: 1, durationMs: 100 });
    expect(results[0]).toMatchObject({ title: "group › retries then passes", status: "flaky", durationMs: 30 });
    expect(results[0]!.attachments.map((a) => [a.kind, a.url])).toEqual([
      ["video", "/artifacts/runs/1/v.webm"],
      ["trace", "/artifacts/runs/1/trace.zip"],
    ]);
    expect(results[1]).toMatchObject({ title: "group › skipped one", status: "skipped", attachments: [] });
  });
});
