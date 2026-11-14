# Software Factory: agent guide

This file holds the rules every agent working on the factory's own code must follow. Keep it short. `README.md` explains what the factory does and how to run it; `docs/INTERFACE.md` is the contract for external agents.

## Commands

```sh
pnpm factory:seed --reset   # fresh dev DB (~/.factory/<repo>/factory.duckdb) with a demo task + screenshots from its artifacts/
pnpm factory:server         # factory API (Hono + DuckDB) on :8787, serves /api and /artifacts
pnpm dev                    # dashboard on http://localhost:5173 (proxies /api to :8787), verification at /verify
pnpm verify       # the gate: lint → typecheck → unit tests → browser tests. Must pass before any handoff.
pnpm lint         # oxlint --deny-warnings
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest (jsdom): verification matrix + unit tests
pnpm e2e          # playwright (headless chromium); screenshots land in artifacts/screenshots/
bin/factory help  # the factory CLI (talks to the API on FACTORY_URL); add --json for machine output
```

The factory runs with no human input and never merges. Agents drive the factory **only through `bin/factory`**, with `FACTORY_ACTOR=agent:<name>` set, never through the database. Exit codes and what agents may do: `docs/INTERFACE.md`.

## Layout

- `shared/`: lifecycle, API contracts and the project config schema (`config.ts`), all zod, used by the server, the CLI and the dashboard.
- `server/`: factory API and orchestrator. `config.ts` loads `factory.config.json` from the target repository. `db.ts` is the only code that writes DuckDB. `app.ts` holds the routes (tested in-process with `:memory:`).
- `cli/`: the `factory` CLI. `init.ts` sets up a target repository; everything else calls the API.
- `.claude/skills/`: the phase skills every stage reads. They ship with the factory; target repositories need no copy.
- `src/dashboard/`: humans give tasks, review screenshots and send feedback. Components are verifiable units; pages do data fetching.
- `src/verify/`: the runtime verification framework and the dashboard's own specs. `factory init` copies `core/`, `verifiers/` and `harness/` into target React apps, with the files in `templates/verify/`, so keep those folders free of anything specific to this dashboard.

## Rules

1. **Every UI component or feature is a verifiable unit.** It must:
   - emit a DOM contract with `verifyAttrs({ unit: "<Id>", ...state })` on its root element;
   - have a spec in `src/verify/specs/<Id>.verify.ts` (registered in `specs/index.ts`) with a zod `propsSchema`, fixtures, and invariants;
   - include **at least one `probe: true` fixture** (an edge case). `matrix.test.ts` enforces this.
2. **Invariants read the DOM contract and the rendered DOM, never React internals.** Return `true`, or a string explaining what was observed.
3. **Don't weaken a check to make it pass.** If a fixture or invariant fails, fix the code. Changing tests or specs written by the test-writer agent is not allowed for implementers.
4. **BLOCKED ≠ FAIL.** BLOCKED means "couldn't observe" (e.g. an `act` selector didn't match). Fix the fixture, don't ignore it.
5. **Add a new kind of check as a verifier** in `src/verify/verifiers/` (one file + one line in `index.ts`), not inside components.
6. **API input is validated with the zod schemas in `shared/api.ts`.** Status changes go through `DECISION_TRANSITIONS` in `shared/lifecycle.ts`, never ad-hoc updates.
7. **Never loosen the `policy` in `factory.config.json` as part of a task.** It decides what always needs a human; changing it always needs a human.
8. TypeScript is `strict` with `noUncheckedIndexedAccess`. No `any` without an `oxlint-disable` comment explaining why.

## How agents verify UI

1. Open `/verify` and call `window.__verify.manifest()` to list every unit × fixture and its route.
2. Navigate to `/verify/<unit>/<fixture>?chrome=0` (a clean mount for screenshots).
3. Wait for `body[data-verify-verdict]`, then read `window.__verify.current()` for a structured result (`verdict`, `checks`, `domSnapshot`).
4. `window.__verify.runAll()` runs the whole matrix in the browser.

## Sharing the dashboard

The API has no authentication and listens on 127.0.0.1 only. To view the dashboard from another machine, set a password and use a tunnel:

```sh
DASHBOARD_PASSWORD=<secret> pnpm dev     # login user: factory
cloudflared tunnel --url http://localhost:5173
```

The API is reached through Vite's proxy, so it is behind the same password. Never run the tunnel without `DASHBOARD_PASSWORD`.

## Environment notes

- **Headless Chromium on Linux without root.** If Chromium's system libraries (`libnss3`, `libnspr4`, ...) are missing and there is no sudo, either ask an admin to run `pnpm exec playwright install-deps chromium`, or run `bin/setup-browser-libs` once (it downloads the Debian 12 packages and unpacks them into `~/.local/share/factory/chromium-libs`, with no maintainer scripts) and prefix browser commands with `bin/with-browser-libs`, for example `bin/with-browser-libs pnpm e2e`. The factory's browser check uses the same folder.
