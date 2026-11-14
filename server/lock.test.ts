// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Lock } from "./lock";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Lock", () => {
  it("runs callers one at a time, in order, and survives a failure", async () => {
    const lock = new Lock();
    const log: string[] = [];
    const job = (name: string, ms: number, fail = false) =>
      lock.run(async () => {
        log.push(`start ${name}`);
        await wait(ms);
        log.push(`end ${name}`);
        if (fail) throw new Error(name);
        return name;
      });
    const results = await Promise.allSettled([job("a", 20), job("b", 1, true), job("c", 1)]);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });
});
