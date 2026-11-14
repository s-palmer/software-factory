// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isAuthorized } from "./basic-auth";

const header = (s: string) => `Basic ${Buffer.from(s).toString("base64")}`;

describe("isAuthorized", () => {
  it("accepts the right credentials", () => {
    expect(isAuthorized(header("factory:s3cret"), "factory", "s3cret")).toBe(true);
  });
  it.each([
    ["missing header", undefined],
    ["wrong password", header("factory:nope")],
    ["wrong user", header("admin:s3cret")],
    ["password prefix", header("factory:s3cre")],
    ["not basic", "Bearer s3cret"],
    ["garbage", "Basic !!!"],
  ])("rejects %s", (_name, value) => {
    expect(isAuthorized(value, "factory", "s3cret")).toBe(false);
  });
});
