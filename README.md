# Software Factory

The software factory turns tickets into tested pull requests without human input. You install it once and point it at any TypeScript repository that uses Vitest. Tickets can live in GitHub issues, Jira, Linear, or any tracker with an MCP server.

Each stage of the work is done by a headless Claude Code agent. Plain TypeScript code moves each task between stages and checks every result before the task can continue. The factory never merges: it opens a draft pull request, fixes failing CI and requested changes itself, then marks the pull request ready with a `risk:low` or `risk:high` label. A person or your own merge agent decides what to merge.

## What it does

```
ticket (GitHub issue, Jira, Linear, ...)
  -> scoping -> design -> test_writing -> implementing -> reviewing -> browser_check -> pr -> awaiting_merge -> done
                                                                                              (or escalated)
```

- **One task per ticket.** You give the factory a ticket key (`#12`, `PROJ-12`), and optionally the tickets it must wait for (`--after`). A task starts only when all its blockers are merged.
- **One agent per stage.** Each stage runs `claude -p` with its own prompt, tool allow list, budget and model. By default Fable does scoping, design, review and decisions, and Opus writes tests, implements, runs the browser check and writes the pull request text. You can change the model per stage or per task.
- **Checks between stages.** Agent output must match a schema. Then code runs the checks: lint, typecheck and tests against the merge base, "the new tests must fail before the change", locked test files, and a risk check.
- **Failures loop back.** A failed check, review, browser check, CI run or change request sends the task back to `implementing` with the failure as feedback. After three failed attempts in a row, the task stops in `escalated`.
- **No questions to people.** A decider agent answers the other agents' questions. It escalates only for money, legal text, security or stored data.
- **A browser check.** For a change with a visible effect, an agent opens your app in headless Chromium through the Playwright MCP server, checks each acceptance criterion and takes screenshots.
- **Runtime verification for React UI** (optional). The test agent writes a `.verify.ts` spec for each UI component it adds or changes: fixtures, edge cases and checks on the rendered DOM. The specs run in Vitest with your other tests, and the factory opens every fixture of the changed components in the browser and keeps a screenshot of each. See [Runtime verification](#runtime-verification).
- **Isolated agents.** Each agent works in its own git worktree. Its file tools cannot leave the worktree, and its shell commands, including the tests it runs, run in Claude Code's OS sandbox: no reads of the rest of your home folder (other projects, credentials, the factory's own data), and no network unless you allow a host.
- **Risk labels.** A pull request that changes a path in the policy (tests, build config, dependencies, auth, payments, migrations, secrets, CI) or is too large gets `risk:high`.

## How it works

```
your repository                       software factory (this folder)
---------------                       ------------------------------
factory.config.json  ---- read ---->  API + orchestrator (127.0.0.1:8787) <---- dashboard (localhost:5173)
                                         |                                 <---- factory CLI (people, agents)
                                         +--> ~/.factory/<repo>/: database, artifacts, a git worktree per task
                                         +--> claude -p per stage: the factory's skills, sandboxed to the worktree,
                                         |      the tracker's MCP server (Jira, Linear) with read tools only
                                         +--> Playwright MCP + Chromium for the browser check
                                         +--> gh: GitHub issues, branch, draft pull request, labels, CI status
```

The factory keeps all its state in `~/.factory/<repo name>/`, outside both repositories, and works in its own git worktrees, so your working copy is never touched. It branches each task from the base branch (`main` unless you set `base`) and opens the pull request against that branch.

| Folder | Contents |
| --- | --- |
| `server/` | The API, the orchestrator loop, the stage prompts and tools (`phases.ts`), git, `gh` and `claude` calls (`effects.ts`), the database, the PM run and the conductor agent |
| `shared/` | Task lifecycle, API contracts, the config schema (`config.ts`), models per stage and the risk check |
| `cli/`, `bin/factory` | The `factory` CLI. `factory init` sets up a repository; the other commands call the API |
| `.claude/skills/` | The skills each stage follows (spec, design, TDD, implement, review, pull request), and `factory-setup`, which sets up a repository from Claude Code |
| `prompts/` | The rules for every headless run, and the conductor agent's prompt |
| `src/dashboard/` | Web UI to add tasks, follow progress, review screenshots, answer escalations, and see the local environment |
| `src/verify/` | The runtime verification framework. `factory init` copies it into React apps; the dashboard also uses it for its own tests |
| `templates/verify/` | The harness page, matrix test and guide that `factory init` adds around the framework |
| `docs/INTERFACE.md` | The contract for agents that drive the factory |

## Prerequisites

On the machine that runs the factory:

- **Node.js** 24 or later (`.nvmrc` pins 24).
- **pnpm** 9 or later.
- **git**.
- **GitHub CLI (`gh`)**, logged in (`gh auth login`) with permission to push branches and create pull requests and labels in your repository (and read issues, if your tickets are GitHub issues).
- **Claude Code (`claude`)** 2.1.314 or later, installed and logged in. Every stage runs it headless. Agent runs cost money: each stage has a budget, and `factory status` shows the total spend.
- **On Linux:** `bubblewrap` and `socat`, for the sandbox. macOS has what it needs.
- **For Jira or Linear:** the tracker's MCP server, added to Claude Code and signed in. `factory init` tells you the commands.

Your repository needs:

- A **GitHub remote**. Pull requests go there.
- **TypeScript** and **Vitest**. The type check reads `tsc` output and the test check uses Vitest's JSON report.
- Any package manager: pnpm, npm, yarn or bun. `factory init` detects it from the lockfile.
- CI on pull requests is optional but recommended. The factory waits for the checks to pass before it marks a pull request ready.

## Getting started

### 1. Install the factory

```sh
git clone <this repository> software-factory
cd software-factory
pnpm install
pnpm exec playwright install chromium     # the browser for the browser check
export PATH="$PWD/bin:$PATH"              # put `factory` on PATH (add this to your shell profile)
```

The Playwright MCP server is a pinned dependency, so `pnpm install` installs it. The factory server does not start without Chromium.

### 2. Set up your repository

Either from Claude Code, in the factory folder:

```text
/factory-setup
```

The skill asks for your repository and ticket system, runs `factory init`, reads your project to fill in the commands and the app, adds the tracker's MCP server, asks you to sign in with `/mcp`, and goes through anything that is missing.

Or in a terminal:

```sh
cd /path/to/your-app
factory init
```

`init` asks where your tickets live (`github`, `jira` or `linear`), the base branch, how to start your app, and, for a React and Vite app, whether to add runtime verification. It writes `factory.config.json` with presets for your package manager, then checks what the factory needs: git remote, `gh`, `claude`, the base branch, Vitest, TypeScript, the tracker's MCP server and its sign-in, and on Linux the sandbox tools. It prints how to fix anything that is missing. For scripts, `factory init --yes --tracker jira --repo <dir>` takes the defaults without questions, and `--json` prints the result as JSON.

For Jira, `init` prints these steps (Linear is the same with `https://mcp.linear.app/mcp/readonly`):

```sh
claude mcp add --scope user --transport http jira https://mcp.atlassian.com/v2/mcp
claude            # then type /mcp, choose "jira" and sign in; agent runs reuse this sign-in
```

Read the config, change what does not fit your project (see [Configuration](#configuration)), then commit and push it:

```sh
git add factory.config.json
git commit -m "Add software factory config"
git push
```

### 3. Start the factory

In the factory folder, in two terminals:

```sh
FACTORY_REPO=/path/to/your-app pnpm factory:server   # API and orchestrator, the loop starts paused
pnpm dev                                             # dashboard on http://localhost:5173
```

### 4. Give it work

Write the ticket with clear acceptance criteria. For a GitHub issue, the factory reads it once and gives it to every agent. For Jira or Linear, the agents read it through the MCP server, with read tools only. Then:

```sh
factory add --ticket "#12"                 # a GitHub issue (or PROJ-12 for Jira and Linear)
factory add --ticket "#13" --after "#12"   # a ticket that waits until #12 is merged
factory start                              # start the loop (or use the switch in the dashboard)
factory list                               # follow progress
```

When a pull request is ready, review and merge it on GitHub. To request changes, use a GitHub review with "Request changes": the factory treats it as feedback and pushes a fix.

## Using the factory

```sh
factory status                  # loop on or off, tasks per stage, total spend
factory show <task>             # one task: runs, history, artifacts, escalation reason
factory events --since 0        # the event feed, oldest first
factory approve <task>          # retry an escalated task
factory changes <task> --comment "..."   # send an escalated task back with feedback
factory stop                    # pause the loop after the current step
factory halt --reason "..."     # kill switch, until a person runs `factory resume`
factory defaults                # show or set the model per stage
factory env                     # the local environment: up or down, which task runs it, who waits, its log
factory help                    # every command; add --json for machine output
```

Agents that drive the factory set `FACTORY_ACTOR=agent:<name>` and pass `--json`. The exit codes, the event feed and the limits on agents are in [docs/INTERFACE.md](docs/INTERFACE.md).

The factory also has a PM run (`factory plan "#7"` or `factory plan specs/idea.md`), which turns an idea into a spec, files tickets as GitHub issues and creates the tasks. It works only when tickets are GitHub issues.

### Runtime verification

For a React and Vite app, `factory init` offers to copy the verification framework into `src/verify/` and add a harness page, `verify.html`, which your dev server serves next to the app (`--verify` or `--no-verify` skip the question). With it on:

```
design        -> names each UI component the ticket touches, the DOM contract it will emit, and the fixtures that matter
test_writing  -> writes src/verify/specs/<Component>.verify.ts (fixtures, at least one edge case, invariants) next to the unit tests
implementing  -> the component's root element emits the contract with verifyAttrs(...); the specs are locked
gate          -> src/verify/matrix.test.ts runs every spec in jsdom with your test command
browser_check -> the factory opens each fixture of the changed components on verify.html, records PASS or FAIL and a
                 screenshot, sends failures back to implement, then the agent checks the pages as usual
pull request  -> the footer lists the components checked and how many fixtures pass
```

Agents may not change the framework itself (`core/`, `verifiers/`, `harness/`), and the policy marks those paths high risk. `src/verify/README.md` in your repository explains how to write a spec. It needs `react`, `react-dom`, `zod` and `jsdom`; `init` tells you which are missing. Run `factory init --force` to update the framework; it never replaces your specs.

### The local environment

The browser check runs against a copy of your app that the factory starts from the task's worktree with `app.start`, and stops afterwards. Only one copy runs at a time. The dashboard's **Environment** page (`/env`, or `factory env`) shows whether it is up, which task runs it and since when, which tasks wait for it, and the end of its log. If something outside the factory answers on the app's URL, the page names the process on the port, and browser checks wait until it stops. You can also start a copy from your checkout there, for example to look at the app yourself; tasks wait while you hold it.

## Configuration

`factory.config.json` at the root of your repository. Every field has a default, so `{}` is a valid file. This is what `factory init` writes for a pnpm project with `dev` and `lint` scripts (the policy is shortened):

```json
{
  "base": "main",
  "remote": "origin",
  "projectDir": "",
  "commands": {
    "install": "pnpm install --frozen-lockfile --prefer-offline",
    "sync": "pnpm install --no-frozen-lockfile --prefer-offline",
    "lint": "pnpm run lint",
    "typecheck": "pnpm exec tsc --noEmit --pretty false",
    "test": "pnpm exec vitest run"
  },
  "app": {
    "start": "pnpm run dev",
    "url": "http://localhost:5173",
    "healthUrls": ["http://localhost:5173"],
    "startTimeoutMs": 300000
  },
  "maxAttempts": 3,
  "tracker": { "type": "github" },
  "sandbox": { "allowedDomains": [], "allowRead": [] },
  "verify": { "enabled": true, "dir": "src/verify", "entry": "/verify.html" },
  "policy": {
    "alwaysHuman": [
      { "pattern": "factory.config.json", "reason": "Changes the factory config or risk policy" },
      { "pattern": "**/*.test.*", "reason": "Changes unit tests" },
      { "pattern": "package.json", "reason": "Adds or changes dependencies or scripts" }
    ],
    "maxChangedFiles": 20,
    "maxChangedLines": 400
  }
}
```

| Field | Meaning |
| --- | --- |
| `base`, `remote` | The branch tasks start from and pull requests target. It must exist on the remote |
| `projectDir` | The app's folder inside the repository, for a monorepo. `""` is the root |
| `commands.install` | Installs dependencies in a fresh worktree |
| `commands.sync` | Reinstalls dependencies when a change touches `package.json` or a lockfile |
| `commands.lint` | Gets the changed files appended. Leave it out to skip linting |
| `commands.typecheck` | Must print `tsc` errors |
| `commands.test` | Must run Vitest. The factory adds `--changed` and reporter flags |
| `app.start` | Starts the task's version of your app for the browser check. Without it, a change with a visible effect escalates at the browser check |
| `app.url`, `app.healthUrls` | Where the browser check opens the app, and the URLs that must answer before it starts |
| `maxAttempts` | Failed attempts in a row before a task escalates |
| `tracker` | `{ "type": "github" }`, or an MCP tracker: `name`, `label`, `server` (an MCP server entry), `tools` (read tools, or `"*"` for a read-only server), `keyPattern`, `instructions`. `factory init` writes the Jira and Linear presets |
| `sandbox.allowedDomains` | Hosts the agents' shell commands and tests may reach. None by default |
| `verify.enabled`, `verify.dir`, `verify.entry` | Runtime verification for React UI: on or off, where the framework lives, and the harness page in the running app |
| `sandbox.allowRead` | Folders outside the worktree the project's tools must read. The rest of the home folder is denied |
| `policy` | Paths that make a pull request high risk, and the size limits |

Agents may run the lint, typecheck and test commands. They may never run the install, sync or start commands, add packages, commit, push, call `gh`, or write to the tracker: the factory does that.

Environment variables override the file and set where the factory keeps its own data:

| Variable | Default | Purpose |
| --- | --- | --- |
| `FACTORY_REPO` | git root of the current folder | The repository the factory works on |
| `FACTORY_HOME` | `~/.factory/<repo name>` | The factory's state for this repository |
| `FACTORY_DB` | `$FACTORY_HOME/factory.duckdb` | The database |
| `FACTORY_ARTIFACTS` | `$FACTORY_HOME/artifacts` | Screenshots, logs, traces and reports |
| `FACTORY_AUTOSTART` | off | `1` starts the loop when the server starts |
| `FACTORY_CLAUDE_COMMAND` | `claude` | Command for agent runs |
| `FACTORY_CHROMIUM` | Playwright's Chromium | Browser for the browser check |
| `FACTORY_POLICY` | the config's `policy` | A separate policy file |
| `FACTORY_BASE`, `FACTORY_REMOTE`, `FACTORY_PROJECT_DIR`, `FACTORY_MAX_ATTEMPTS` | the config | Override single fields |
| `FACTORY_INSTALL`, `FACTORY_SYNC`, `FACTORY_LINT`, `FACTORY_TYPECHECK`, `FACTORY_TEST` | the config | Override single commands |
| `FACTORY_ENV_START`, `FACTORY_ENV_HEALTH`, `FACTORY_BROWSER_URL` | the config | Override the app settings |
| `FACTORY_INTAKE_POLL_MS`, `FACTORY_CONDUCTOR_MS` | `0` (off) | The built-in PM intake and conductor agent |
| `FACTORY_URL`, `FACTORY_ACTOR` | `http://127.0.0.1:8787`, `human` | Used by the CLI |
| `API_PORT` | `8787` | API port |

Run one factory server per repository. Each repository gets its own `~/.factory/<repo name>/`. To work on another repository at the same time, start another server with a different `FACTORY_REPO` and `API_PORT`, and its dashboard with the same `API_PORT` (and `pnpm dev --port <port>`). Point the CLI at it with `FACTORY_URL`.

### Sharing the dashboard

The API has no authentication and listens on 127.0.0.1 only. To reach the dashboard from another machine, set a password and use a tunnel:

```sh
DASHBOARD_PASSWORD=<secret> pnpm dev      # login user: factory
cloudflared tunnel --url http://localhost:5173
```

Do not run a tunnel without `DASHBOARD_PASSWORD`.

## Developing the factory

The factory can work on its own code: this repository has its own `factory.config.json`.

```sh
pnpm verify      # lint, typecheck, unit tests, browser tests: must pass before any change is handed over
pnpm lint        # oxlint --deny-warnings
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest
pnpm e2e         # playwright, headless Chromium
pnpm factory:seed --reset   # a dev database with a demo task
```

Rules for people and agents working on this code are in `claude.md`.
