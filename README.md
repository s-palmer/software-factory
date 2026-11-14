# Software Factory

The software factory turns GitHub issues into tested pull requests without human input. You install it once and point it at any TypeScript repository that uses Vitest.

Each stage of the work is done by a headless Claude Code agent. Plain TypeScript code moves each task between stages and checks every result before the task can continue. The factory never merges: it opens a draft pull request, fixes failing CI and requested changes itself, then marks the pull request ready with a `risk:low` or `risk:high` label. A person or your own merge agent decides what to merge.

## What it does

```
GitHub issue
  -> scoping -> design -> test_writing -> implementing -> reviewing -> browser_check -> pr -> awaiting_merge -> done
                                                                                              (or escalated)
```

- **One task per issue.** You give the factory an issue number, and optionally the issues it must wait for (`--after`). A task starts only when all its blockers are merged.
- **One agent per stage.** Each stage runs `claude -p` with its own prompt, tool allow list, budget and model. By default Fable does scoping, design, review and decisions, and Opus writes tests, implements, runs the browser check and writes the pull request text. You can change the model per stage or per task.
- **Checks between stages.** Agent output must match a schema. Then code runs the checks: lint, typecheck and tests against the merge base, "the new tests must fail before the change", locked test files, and a risk check.
- **Failures loop back.** A failed check, review, browser check, CI run or change request sends the task back to `implementing` with the failure as feedback. After three failed attempts in a row, the task stops in `escalated`.
- **No questions to people.** A decider agent answers the other agents' questions. It escalates only for money, legal text, security or stored data.
- **A browser check.** For a change with a visible effect, an agent opens your app in headless Chromium through the Playwright MCP server, checks each acceptance criterion and takes screenshots.
- **Risk labels.** A pull request that changes a path in the policy (tests, build config, dependencies, auth, payments, migrations, secrets, CI) or is too large gets `risk:high`.

## How it works

```
your repository                       software factory (this folder)
---------------                       ------------------------------
factory.config.json  ---- read ---->  API + orchestrator (127.0.0.1:8787) <---- dashboard (localhost:5173)
                                         |                                 <---- factory CLI (people, agents)
                                         +--> DuckDB: tasks, runs, events
                                         +--> git worktree per task (~/.factory/<repo>/worktrees)
                                         +--> claude -p per stage, with the factory's skills
                                         +--> Playwright MCP + Chromium for the browser check
                                         +--> gh: branch, draft pull request, labels, CI status
```

The factory works in its own git worktrees, so your working copy is never touched. It branches each task from the base branch (`main` unless you set `base`) and opens the pull request against that branch.

| Folder | Contents |
| --- | --- |
| `server/` | The API, the orchestrator loop, the stage prompts and tools (`phases.ts`), git, `gh` and `claude` calls (`effects.ts`), the database, the PM run and the conductor agent |
| `shared/` | Task lifecycle, API contracts, the config schema (`config.ts`), models per stage and the risk check |
| `cli/`, `bin/factory` | The `factory` CLI. `factory init` sets up a repository; the other commands call the API |
| `.claude/skills/` | The skills each stage follows (spec, design, TDD, implement, review, pull request) |
| `prompts/` | The rules for every headless run, and the conductor agent's prompt |
| `src/dashboard/` | Web UI to add tasks, follow progress, review screenshots and answer escalations |
| `docs/INTERFACE.md` | The contract for agents that drive the factory |

## Prerequisites

On the machine that runs the factory:

- **Node.js** 24 or later (`.nvmrc` pins 24).
- **pnpm** 9 or later.
- **git**.
- **GitHub CLI (`gh`)**, logged in (`gh auth login`) with permission to read issues, push branches, and create pull requests and labels in your repository.
- **Claude Code (`claude`)**, installed and logged in. Every stage runs it headless. Agent runs cost money: each stage has a budget, and `factory status` shows the total spend.

Your repository needs:

- A **GitHub remote**. The issues the factory works on live there.
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

```sh
cd /path/to/your-app
factory init
```

`init` writes `factory.config.json` with presets for your package manager, then checks what the factory needs: git remote, `gh`, `claude`, the base branch, Vitest and TypeScript. It prints how to fix anything that is missing. Read the config, change what does not fit your project (see [Configuration](#configuration)), then commit and push it:

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

Write the issue with clear acceptance criteria: the scoping agent reads it with `gh issue view`. Then:

```sh
factory add --ticket "#12"                 # an issue
factory add --ticket "#13" --after "#12"   # an issue that waits until #12 is merged
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
factory help                    # every command; add --json for machine output
```

Agents that drive the factory set `FACTORY_ACTOR=agent:<name>` and pass `--json`. The exit codes, the event feed and the limits on agents are in [docs/INTERFACE.md](docs/INTERFACE.md).

The factory also has a PM run (`factory plan "#7"` or `factory plan specs/idea.md`), which turns an idea into a spec, files tickets as issues and creates the tasks.

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
| `app.start` | Starts your app for the browser check. Leave it out if the app is already running at `app.url` |
| `app.url`, `app.healthUrls` | Where the browser check opens the app, and the URLs that must answer before it starts |
| `maxAttempts` | Failed attempts in a row before a task escalates |
| `policy` | Paths that make a pull request high risk, and the size limits |

Agents may run the lint, typecheck and test commands. They may never run the install, sync or start commands, add packages, commit, push, or write to GitHub: the factory does that.

Environment variables override the file and set where the factory keeps its own data:

| Variable | Default | Purpose |
| --- | --- | --- |
| `FACTORY_REPO` | git root of the current folder | The repository the factory works on |
| `FACTORY_HOME` | `~/.factory/<repo name>` | Task worktrees and run logs |
| `FACTORY_DB` | `data/factory.duckdb` | The database, in the factory folder |
| `FACTORY_ARTIFACTS` | `artifacts` | Screenshots, traces and reports |
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

Run one factory server per repository. To work on another repository at the same time, start another server with a different `FACTORY_REPO`, `FACTORY_DB` and `API_PORT`, and its dashboard with the same `API_PORT` (and `pnpm dev --port <port>`). Point the CLI at it with `FACTORY_URL`.

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
