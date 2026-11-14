# Runtime verification

The software factory copied this folder here. It checks each UI component by mounting it in a known state (a fixture) and reading the rendered DOM. The same check runs in Vitest (jsdom, `matrix.test.ts`) and in a real browser (the harness page `{{entry}}`).

Do not edit `core/`, `verifiers/` or `harness/`: run `factory init --force` to update them. Your specs go in `specs/`.

## Rules for a UI unit

1. **The root element emits a DOM contract:** `verifyAttrs({ unit: "<Id>", ...state })` from `{{dir}}/core/contract`, spread on the root element. Use kebab-case keys (`"can-save": canSave`). The values describe what the unit shows, for example a count or a mode.
2. **Each unit has a spec** in `specs/<Id>.verify.ts`, imported in `specs/index.ts`. It has a zod `propsSchema`, fixtures and invariants.
3. **At least one fixture has `probe: true`:** an edge case such as empty, loading, an error, or a very long value. The matrix test fails without one.
4. **Invariants read the DOM contract and the rendered DOM, never React internals.** Return `true`, or a string that says what was observed.
5. **BLOCKED is not FAIL.** BLOCKED means the check could not observe, for example an `act` selector did not match. Fix the fixture.

## A spec

```ts
import { createElement } from "react";
import { z } from "zod";
import { CartSummary, type CartSummaryProps } from "../../components/CartSummary";
import { registerUnit } from "../core/registry";

registerUnit<CartSummaryProps>({
  id: "CartSummary",
  title: "CartSummary",
  description: "The cart total and the number of items, with a checkout button.",
  kind: "component",
  render: (props) => createElement(CartSummary, props),
  propsSchema: z.object({ items: z.array(z.object({ name: z.string(), price: z.number() })), onCheckout: z.function() }),
  fixtures: [
    { id: "two-items", description: "Two items.", props: { items: [{ name: "Tea", price: 3 }, { name: "Cake", price: 4.5 }], onCheckout: () => {} } },
    { id: "empty", probe: true, description: "Probe: no items; checkout is disabled.", props: { items: [], onCheckout: () => {} } },
    { id: "checkout", description: "Clicking checkout.", props: { items: [{ name: "Tea", price: 3 }], onCheckout: () => {} }, act: (ctx) => ctx.click("button") },
  ],
  invariants: [
    {
      id: "count-matches",
      description: "The contract's count equals the number of items",
      check: ({ contract, props }) => contract.count === String(props.items.length) || `count=${contract.count}`,
    },
    {
      id: "empty-disables-checkout",
      description: "Checkout is disabled when the cart is empty",
      check: ({ root, props }) => root.querySelector("button")?.disabled === (props.items.length === 0) || "button state wrong",
    },
  ],
});
```

`act` steps run after mount: `ctx.click(selector)`, `ctx.type(selector, text)`, `ctx.select(selector, value)`, `ctx.wait(ms)`.

## Running

- `{{entry}}` in the running app lists every unit and fixture, and runs them.
- `{{entry}}?unit=<id>&fixture=<id>&chrome=0` mounts one fixture for a screenshot. `body[data-verify-verdict]` appears when it is done, and `window.__verify.current()` gives the result.
- The factory runs `matrix.test.ts` with the other tests, and opens the changed units' fixtures in the browser check.
