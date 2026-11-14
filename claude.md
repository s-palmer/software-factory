# Simple Software Factory: rules for agents

Every agent that works on the factory's own code follows these rules. Keep the file short. `README.md` explains what the factory does and how to run it, and `docs/INTERFACE.md` is the contract for agents that drive it.

## Commands

```sh
pnpm factory:seed --reset   # a new dev database (~/.factory/<repo>/factory.duckdb) with a demo task and screenshots from its artifacts/
pnpm factory:server         # the factory API (Hono and DuckDB) on :8787; serves /api and /artifacts
pnpm dev                    # the dashboard on http://localhost:5173 (proxies /api to :8787); verification at /verify
pnpm verify       # the gate: lint, type check, unit tests, browser tests. Must pass before any handoff
pnpm lint         # oxlint --deny-warnings
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest (jsdom): the verification matrix and the unit tests
pnpm e2e          # playwright (headless Chromium); screenshots go to artifacts/screenshots/
bin/factory help  # the factory CLI (talks to the API at FACTORY_URL); add --json for machine output
```

The factory runs with no person in the loop and never merges. Agents drive it only through `bin/factory`, with `FACTORY_ACTOR=agent:<name>` set, and never through the database. `docs/INTERFACE.md` lists the exit codes and what agents may do.

## Layout

- `shared/`: the lifecycle, API contracts and project config schema (`config.ts`), all in zod. The server, the CLI and the dashboard use them.
- `server/`: the factory API and orchestrator. `config.ts` loads `factory.config.json` from the target repository. `db.ts` is the only code that writes to DuckDB. `app.ts` holds the routes, which are tested in-process against `:memory:`.
- `cli/`: the `factory` CLI. `init.ts` sets up a target repository; everything else calls the API.
- `.claude/skills/`: the skills each stage reads. They ship with the factory, so target repositories need no copy.
- `src/dashboard/`: where people give tasks, review screenshots and send feedback. Components are verifiable units; pages fetch the data.
- `src/verify/`: the runtime verification framework and the dashboard's own specs. `factory init` copies `core/`, `verifiers/` and `harness/` into target React apps, with the files in `templates/verify/`. Keep those folders free of anything specific to this dashboard.

## Rules

1. Every UI component or feature is a verifiable unit. It must:
   - emit a DOM contract with `verifyAttrs({ unit: "<Id>", ...state })` on its root element;
   - have a spec in `src/verify/specs/<Id>.verify.ts`, imported in `specs/index.ts`, with a zod `propsSchema`, fixtures and invariants;
   - have at least one `probe: true` fixture, an edge case. `matrix.test.ts` enforces this.
2. Invariants read the DOM contract and the rendered DOM, never React internals. They return `true`, or a string that says what they saw.
3. Do not weaken a check to make it pass. If a fixture or invariant fails, fix the code. Implementers may not change tests or specs that the test writer wrote.
4. BLOCKED is not FAIL. BLOCKED means the check could not observe, for example because an `act` selector matched nothing. Fix the fixture; do not ignore it.
5. Add a new kind of check as a verifier in `src/verify/verifiers/` (one file and one line in `index.ts`), not inside a component.
6. The zod schemas in `shared/api.ts` validate all API input. Status changes go through `DECISION_TRANSITIONS` in `shared/lifecycle.ts`, never through ad hoc updates.
7. Never loosen the `policy` in `factory.config.json` as part of a task. It decides what always needs a person, so changing it always needs a person.
8. TypeScript is `strict`, with `noUncheckedIndexedAccess`. Use no `any` without an `oxlint-disable` comment that says why.

## How agents check UI

1. Open `/verify` and call `window.__verify.manifest()` to list every unit, fixture and route.
2. Go to `/verify/<unit>/<fixture>?chrome=0`, which mounts one fixture with nothing around it, for screenshots.
3. Wait for `body[data-verify-verdict]`, then read `window.__verify.current()` for the result (`verdict`, `checks`, `domSnapshot`).
4. `window.__verify.runAll()` runs every fixture in the browser.

## Sharing the dashboard

The API has no authentication and listens on 127.0.0.1 only. To view the dashboard from another machine, set a password and use a tunnel:

```sh
DASHBOARD_PASSWORD=<secret> pnpm dev     # login user: factory
cloudflared tunnel --url http://localhost:5173
```

The browser reaches the API through Vite's proxy, so the same password protects it. Never run the tunnel without `DASHBOARD_PASSWORD`.

## Headless Chromium on Linux without root

Chromium may lack system libraries (`libnss3`, `libnspr4` and others) on a Linux machine where you have no sudo. Either ask an administrator to run `pnpm exec playwright install-deps chromium`, or run `bin/setup-browser-libs` once. That script downloads the Debian 12 packages and unpacks them into `~/.local/share/factory/chromium-libs`, without running their install scripts. Then prefix browser commands with `bin/with-browser-libs`, for example `bin/with-browser-libs pnpm e2e`. The factory's browser check uses the same folder.
