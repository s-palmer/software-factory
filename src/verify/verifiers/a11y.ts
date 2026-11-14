/** Small, dependency-free a11y checks. Swap for axe-core when it starts to matter. */
import { registerVerifier } from "../core/registry";
import type { Check } from "../core/types";

function hasAccessibleName(el: Element): boolean {
  return Boolean(
    el.getAttribute("aria-label") ||
      el.getAttribute("aria-labelledby") ||
      el.getAttribute("title") ||
      el.textContent?.trim(),
  );
}

function isLabelled(el: Element, root: HTMLElement): boolean {
  if (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby")) return true;
  if (el.id && root.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return true;
  return el.closest("label") !== null;
}

export const a11yVerifier = registerVerifier({
  id: "a11y",
  description: "Buttons are named, inputs are labelled, images have alt text.",
  run({ fixture, root }) {
    const ok = fixture.probe ? "probe" : "ok";
    const checks: Check[] = [];
    const rules: Array<[string, Element[], (el: Element) => boolean]> = [
      ["button(s) have accessible names", Array.from(root.querySelectorAll("button, [role=button]")), hasAccessibleName],
      ["input(s) are labelled", Array.from(root.querySelectorAll("input:not([type=hidden]), textarea, select")), (el) => isLabelled(el, root)],
      ["image(s) have alt text", Array.from(root.querySelectorAll("img")), (el) => el.hasAttribute("alt")],
    ];
    for (const [label, els, passes] of rules) {
      if (els.length === 0) continue;
      const bad = els.filter((el) => !passes(el));
      checks.push(
        bad.length === 0
          ? { verifier: "a11y", status: ok, label: `All ${els.length} ${label}` }
          : {
              verifier: "a11y",
              status: "fail",
              label: `${bad.length}/${els.length} ${label.replace("have", "missing").replace("are", "not")}`,
              detail: bad.map((el) => el.outerHTML.slice(0, 80)).join(" | "),
            },
      );
    }
    return checks.length > 0 ? checks : [{ verifier: "a11y", status: ok, label: "No interactive elements to check" }];
  },
});
