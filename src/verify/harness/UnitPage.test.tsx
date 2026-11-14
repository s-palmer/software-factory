import { StrictMode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import "../verifiers";
import "../specs";
import { UnitPage } from "./UnitPage";

describe("UnitPage", () => {
  it("mounts one fixture once under StrictMode, which runs effects twice in dev", async () => {
    const page = document.createElement("div");
    document.body.appendChild(page);
    const root = createRoot(page);
    await act(async () => {
      root.render(
        <StrictMode>
          <UnitPage unitId="SteerPanel" fixtureId="running" />
        </StrictMode>,
      );
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    const stage = page.querySelector("[data-verify-stage]")!;
    expect(stage.children).toHaveLength(1);
    expect(stage.querySelectorAll('[data-verify-unit="SteerPanel"]')).toHaveLength(1);
    expect(page.textContent).toContain("PASS");
    act(() => root.unmount());
    page.remove();
  });
});
