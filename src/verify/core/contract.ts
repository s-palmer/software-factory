/**
 * The DOM contract: components emit `data-verify-*` attributes so the rendered DOM is
 * machine-readable ground truth. Verifiers and agents read this, not React internals.
 */
export const VERIFY_PREFIX = "data-verify-";

export function verifyAttrs(
  attrs: Record<string, string | number | boolean | null | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    out[`${VERIFY_PREFIX}${key}`] = String(value);
  }
  return out;
}

function attrsOf(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith(VERIFY_PREFIX)) out[attr.name.slice(VERIFY_PREFIX.length)] = attr.value;
  }
  return out;
}

/** Contract of the first `data-verify-unit` element at or inside `root`. */
export function readContract(root: HTMLElement): Record<string, string> {
  const el = root.hasAttribute(`${VERIFY_PREFIX}unit`)
    ? root
    : root.querySelector(`[${VERIFY_PREFIX}unit]`);
  return el ? attrsOf(el) : {};
}

/** Contracts of every `data-verify-unit` element inside `root` (optionally of one unit id). */
export function readAllContracts(root: HTMLElement, unitId?: string): Record<string, string>[] {
  const selector = unitId ? `[${VERIFY_PREFIX}unit="${unitId}"]` : `[${VERIFY_PREFIX}unit]`;
  return Array.from(root.querySelectorAll(selector)).map(attrsOf);
}
