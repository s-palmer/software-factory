# Software factory

The software factory turns tickets into tested pull requests with no person in the loop. You install it once and point it at a TypeScript repository that uses Vitest or Jest. Tickets can live in GitHub issues, Jira, Linear or any tracker with an MCP server.

A headless Claude Code agent (one that runs with no person at the keyboard) does each stage of the work. Plain TypeScript code moves each task from stage to stage and checks every result before the task goes on. The factory never merges. It opens a draft pull request, fixes failing CI and requested changes itself, and then marks the pull request ready for review, with its risk level in the description. A person, or your own merge agent, decides what to merge.

The agents follow skills, one or more per stage. By default these are [Matt Pocock's skills](https://github.com/mattpocock/skills) (MIT licence), copied into `.claude/skills/`. You can replace them with your team's own skills, for some stages or for all of them. See [Skills](#skills).

## What it does

```
ticket (GitHub issue, Jira, Linear, ...)
  -> scoping -> design -> test_writing -> implementing -> reviewing -> browser_check -> pr -> awaiting_merge -> done
                                                                                              (or escalated)
```

Each ticket becomes one task. You give the factory a ticket key, such as `#12` or `PROJ-12`, and the tickets it must wait for (`--after`). A task starts only when all its blockers are merged.

Each stage runs `claude -p` with its own prompt, tool allow list, budget and model. By default Fable does scoping, design, review and decisions; Opus writes the tests, the code, the browser check and the pull request text. You can change the model for a stage, for one task or for all tasks.

Code checks the work between stages. Agent output must match a schema. Then the factory runs lint, the type check and the tests against the merge base, confirms that new tests failed before the change, and refuses edits to locked test files. A risk check runs last.

A failure goes back to `implementing` with the failure as feedback. That covers a failed check, review, browser check or CI run, and a change request. After three failed attempts in a row the task stops in `escalated`.

No agent asks a person a question. A decider agent answers the others' questions, and escalates only when money, legal text, security or stored data is at stake.

For a change with a visible effect, an agent opens your app in headless Chromium through the Playwright MCP server. It checks each acceptance criterion and takes a screenshot of each.

For React apps there is optional runtime verification. The test agent writes a `.verify.ts` spec for each UI component it adds or changes, with fixtures, edge cases and checks on the rendered DOM. The specs run in Vitest with your other tests. In the browser check the factory opens every fixture of the changed components and keeps a screenshot of each. See [Runtime verification](#runtime-verification).

Each agent works in its own git worktree, and cannot read or write files outside it. Its shell commands, and the tests they start, run in Claude Code's operating-system sandbox. They cannot read the rest of your home folder: other projects, credentials and the factory's own data are out of reach. They have no network unless you allow a host.

A pull request is high risk when it is too large or changes a path in the risk policy: tests, build configuration, dependencies, authentication, payments, migrations, secrets or CI. The factory adds no labels to your repository; the risk and its reasons are in the pull request's footer and in the task.

## How it works

```
your repository                       software factory (this folder)
---------------                       ------------------------------
factory.config.json  ---- read ---->  API + orchestrator (127.0.0.1:8787) <---- dashboard (localhost:5173)
                                         |                                 <---- factory CLI (people, agents)
                                         +--> ~/.factory/<repo>/: database, artifacts, a git worktree per task
                                         +--> claude -p per stage: the skills, sandboxed to the worktree,
                                         |      the tracker's MCP server (Jira, Linear) with read tools only
                                         +--> Playwright MCP + Chromium for the browser check
                                         +--> gh: GitHub issues, branch, draft pull request, CI status
```

The factory keeps its state in `~/.factory/<repo name>/`, outside both repositories, and works only in its own worktrees. Your working copy is never touched. Each task branches from the base branch (`main` unless you set `base`), and its pull request targets that branch.

| Folder | Contents |
| --- | --- |
| `server/` | The API, the orchestrator loop, the stage prompts and tools (`phases.ts`), the git, `gh` and `claude` calls (`effects.ts`), the database, the PM run and the conductor agent |
| `shared/` | The task lifecycle, API contracts, config schema (`config.ts`), models per stage and the risk check |
| `cli/`, `bin/factory` | The `factory` CLI. `factory init` sets up a repository; the other commands call the API |
| `.claude/skills/` | The skills each stage follows, and `factory-setup`, which sets up a repository from Claude Code |
| `prompts/` | The rules for every headless run, and the conductor agent's prompt |
| `src/dashboard/` | The web dashboard: add tasks, follow progress, review screenshots, answer escalations, see the local environment |
| `src/verify/` | The runtime verification framework. `factory init` copies it into React apps; the dashboard uses it for its own tests |
| `templates/verify/` | The harness page, matrix test and guide that `factory init` adds around the framework |
| `docs/INTERFACE.md` | The contract for agents that drive the factory |

## Prerequisites

The machine that runs the factory needs:

- Node.js 24 or later (`.nvmrc` pins 24).
- pnpm 9 or later, and git.
- The GitHub CLI (`gh`), logged in with `gh auth login`. It must be able to push branches and create pull requests in your repository, and to read issues if your tickets are GitHub issues.
- Claude Code (`claude`) 2.1.314 or later, installed and logged in. Every stage runs it headless. Agent runs cost money: each stage has a budget, and `factory status` shows the total spent.
- On Linux, `bubblewrap` and `socat` for the sandbox. macOS needs nothing extra.
- For Jira or Linear, the tracker's MCP server, added to Claude Code and signed in. `factory init` prints the commands.

Your repository needs a GitHub remote, TypeScript, and Vitest or Jest. The next section lists everything else the factory relies on.

## Preparing your codebase

The factory can check only what your repository lets it check. Go through this list before you give it a ticket. `factory init` and `/factory-setup` check the items marked "checked".

1. A GitHub remote and a base branch (checked). Pull requests go to GitHub, against `base`, which is `main` by default. `gh repo view` must work in the repository.
2. Tests that run headless with no network (checked). Set `commands.test` to the command that runs your unit tests, and `commands.testRunner` to `vitest` or `jest`. The factory adds the runner's flags so that only the tests a change touches run. Agents run tests in a sandbox with no network, so tests must not call real services. If some tests need a host, list it in `sandbox.allowedDomains`.
3. A type check that prints `tsc` errors, set in `commands.typecheck`, for example `pnpm exec tsc --noEmit --pretty false`. The gate compares the errors with those on the merge base, so old errors in your code do not block a change. A wrapper that prints only counts makes this check weak.
4. A linter that takes file paths, if you have one. `commands.lint` gets the changed files appended. Leave it out if you have no linter.
5. A way to start the app locally, for UI work. `app.start` starts the app from a task's worktree, and every URL in `app.healthUrls` must answer when it is up. Self-signed certificates are fine. The app must use fixed ports, because the factory runs one copy at a time. Without `app.start`, a change with a visible effect escalates at the browser check. If the app needs a sign-in, see `app.browserProfile` below.
6. An install that uses the lockfile (checked). `commands.install` runs in every new worktree. In a large monorepo the first install takes a few minutes.
7. Rules for agents. Agents load your `CLAUDE.md`, and the files it imports, as a person's Claude Code session does. Put your conventions there: folder layout, naming, how to test and what not to touch.
8. Tickets with acceptance criteria. The ticket is the spec, so write down what must be true when the work is done. The scoping agent turns that into testable criteria, and the browser check checks each one.
9. A risk policy that fits your code. `policy.alwaysHuman` lists the paths that make a pull request high risk. Add your authentication, payment, infrastructure and migration folders.
10. For Jira or Linear, the tracker's MCP server (checked), added to Claude Code under the name in `tracker.name` and signed in with `/mcp`.
11. CI on pull requests, which is optional but recommended. The factory waits for green checks before it marks a pull request ready, and fixes failures itself.
12. Runtime verification for React UI, if you want it. It needs Vitest. `factory init --verify` copies the framework in. See [Runtime verification](#runtime-verification).

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

You can do this from Claude Code, in the factory folder:

```text
/factory-setup
```

The skill asks for your repository and ticket system and runs `factory init`. It reads your project to fill in the commands and the app, adds the tracker's MCP server, and asks you to sign in with `/mcp`. Then it goes through anything that is missing.

Or you can do it in a terminal:

```sh
cd /path/to/your-app
factory init
```

`init` asks where your tickets live (`github`, `jira` or `linear`), which branch to use as the base and how to start your app. For a React and Vite app it also asks whether to add runtime verification. It writes `factory.config.json`, with presets for your package manager. Then it checks what the factory needs: the git remote, `gh`, `claude`, the base branch, the test runner, TypeScript, the tracker's MCP server and its sign-in, and on Linux the sandbox tools. It prints how to fix anything that is missing.

In a script, `factory init --yes --tracker jira --repo <dir>` takes the defaults without asking, and `--json` prints the result as JSON.

For Jira, `init` prints these steps. Linear is the same, with `https://mcp.linear.app/mcp/readonly`.

```sh
claude mcp add --scope user --transport http jira https://mcp.atlassian.com/v2/mcp
claude            # then type /mcp, choose "jira" and sign in; agent runs reuse this sign-in
```

Read the config and change what does not fit your project (see [Configuration](#configuration)). Then commit and push it:

```sh
git add factory.config.json
git commit -m "Add software factory config"
git push
```

### 3. Start the factory

In the factory folder, in two terminals:

```sh
FACTORY_REPO=/path/to/your-app pnpm factory:server   # API and orchestrator; the loop starts paused
pnpm dev                                             # dashboard on http://localhost:5173
```

To keep the config out of your repository, for a first try, put it anywhere and set `FACTORY_CONFIG` to its path.

### 4. Give it work

Write the ticket with clear acceptance criteria. The factory reads a GitHub issue once and gives it to every agent. Agents read a Jira or Linear ticket themselves, through the MCP server and with read tools only. Then:

```sh
factory add --ticket "#12"                 # a GitHub issue (or PROJ-12 for Jira and Linear)
factory add --ticket "#13" --after "#12"   # a ticket that waits until #12 is merged
factory start                              # start the loop (or use the switch in the dashboard)
factory list                               # follow progress
```

When a pull request is ready, review and merge it on GitHub. To ask for changes, submit a GitHub review with "Request changes". The factory treats the review as feedback and pushes a fix.

## Using the factory

```sh
factory status                  # loop on or off, tasks per stage, total spent
factory show <task>             # one task: runs, history, artifacts, why it escalated
factory events --since 0        # the event feed, oldest first
factory approve <task>          # retry an escalated task
factory changes <task> --comment "..."   # send an escalated task back with feedback
factory stop                    # pause the loop after the current step
factory halt --reason "..."     # stop everything until a person runs `factory resume`
factory defaults                # show or set the model per stage
factory env                     # the local environment: up or down, which task runs it, who waits, its log
factory help                    # every command; add --json for machine output
```

Agents that drive the factory set `FACTORY_ACTOR=agent:<name>` and pass `--json`. [docs/INTERFACE.md](docs/INTERFACE.md) describes the exit codes, the event feed and the limits on agents.

The factory also has a PM run (`factory plan "#7"` or `factory plan specs/idea.md`). It turns an idea into a spec, files tickets as GitHub issues and creates the tasks. It works only when tickets are GitHub issues.

### Skills

Each stage reads its skill files before it starts. They are the same skills a person can use in Claude Code.

| Stage | Default skills (Matt Pocock's) |
| --- | --- |
| scoping | `to-spec` |
| design | `codebase-design`, `domain-modeling` |
| test_writing | `tdd` |
| implementing | `implement`, `tdd` |
| reviewing | `code-review` |
| pr | `pr` |
| planning (PM run) | `to-spec`, `to-tickets` |

The factory adds rules for a run with no person present: no questions to a person, no commits and no writes to the tracker. Where a skill says otherwise, these rules win.

To use your own skills, point `skills.dir` at your skills folder, either absolute or relative to the repository root. Then list each stage's files in `skills.stages`, relative to that folder:

```json
"skills": {
  "dir": ".claude/skills",
  "stages": {
    "design": ["architecture/SKILL.md"],
    "reviewing": ["review-checklist/SKILL.md", "security-review/SKILL.md"]
  }
}
```

A stage you list gets your files and the factory's general rules. It does not get the notes the factory adds for the default skills, which refer to their templates and steps. A stage you do not list keeps its default file names, so once `skills.dir` is set, those files must exist in your folder too. To replace every stage, list them all. Agents can read the skills folder but not change it.

### Runtime verification

For a React and Vite app, `factory init` offers to copy the verification framework into `src/verify/`. It also adds a harness page, `verify.html`, which your dev server serves next to the app. `--verify` and `--no-verify` answer the question in advance. With verification on:

```
design        -> names each UI component the ticket touches, the DOM contract it will emit, and the fixtures that matter
test_writing  -> writes src/verify/specs/<Component>.verify.ts (fixtures, at least one edge case, invariants) next to the unit tests
implementing  -> the component's root element emits the contract with verifyAttrs(...); the specs are locked
gate          -> src/verify/matrix.test.ts runs every spec in jsdom with your test command
browser_check -> the factory opens each fixture of the changed components on verify.html, records PASS or FAIL and a
                 screenshot, sends failures back to implement, then the agent checks the pages as usual
pull request  -> the footer lists the components checked and how many fixtures pass
```

Agents may not change the framework itself (`core/`, `verifiers/` and `harness/`), and the policy marks those paths high risk. `src/verify/README.md` in your repository explains how to write a spec. The framework needs `react`, `react-dom`, `zod` and `jsdom`; `init` tells you which are missing. To update the framework, run `factory init --force`. It never replaces your specs.

### The local environment

The browser check runs against a copy of your app. The factory starts it from the task's worktree with `app.start`, and stops it afterwards. Only one copy runs at a time.

The dashboard's Environment page (`/env`, or `factory env` in a terminal) shows whether the app is up, which task runs it and since when, which tasks are waiting and the end of its log. If something outside the factory answers on the app's URL, the page names the process on the port, and browser checks wait until it stops. You can also start a copy from your checkout there, for example to look at the app yourself. Tasks wait while you hold it.

## Configuration

`factory.config.json` lives at the root of your repository. Every field has a default, so `{}` is a valid file. This is what `factory init` writes for a pnpm project with `dev` and `lint` scripts (the policy is shortened):

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
    "test": "pnpm exec vitest run",
    "testRunner": "vitest"
  },
  "app": {
    "start": "pnpm run dev",
    "url": "http://localhost:5173",
    "healthUrls": ["http://localhost:5173"],
    "startTimeoutMs": 300000
  },
  "maxAttempts": 3,
  "tracker": { "type": "github" },
  "skills": { "stages": {} },
  "verify": { "enabled": true, "dir": "src/verify", "entry": "/verify.html" },
  "sandbox": { "allowedDomains": [], "allowRead": [] },
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
| `commands.install` | Installs dependencies in a new worktree |
| `commands.sync` | Reinstalls dependencies when a change touches `package.json` or a lockfile |
| `commands.lint` | Gets the changed files appended. Leave it out to skip linting |
| `commands.typecheck` | Must print `tsc` errors |
| `commands.test` | Runs your unit tests. The factory adds the runner's flags for changed files and a JSON report |
| `commands.testRunner` | `vitest` (the default) or `jest` |
| `app.start` | Starts the task's copy of your app for the browser check. Without it, a change with a visible effect escalates at the browser check |
| `app.url`, `app.healthUrls` | Where the browser check opens the app, and the URLs that must answer before it starts |
| `app.browserProfile` | A Chrome profile folder where a person signed in to the app. The browser check then runs in Google Chrome on that profile, signed in. Without it, the check runs signed out. To make one, start the app, run `pnpm exec playwright open --channel chrome --ignore-https-errors --user-data-dir ~/.factory/browser-profile <app url>` from the factory folder, sign in, and close the window. Chrome locks a profile while a window has it open |
| `maxAttempts` | Failed attempts in a row before a task escalates |
| `tracker` | `{ "type": "github" }`, or an MCP tracker: `name`, `label`, `server` (an MCP server entry), `tools` (its read tools, or `"*"` for a read-only server), `keyPattern` and `instructions`. `factory init` writes the presets for Jira and Linear |
| `skills.dir`, `skills.stages` | Your own skills folder, and the skill files for each stage. See [Skills](#skills) |
| `verify.enabled`, `verify.dir`, `verify.entry` | Runtime verification for React UI: whether it is on, where the framework lives, and the harness page in the running app |
| `sandbox.allowedDomains` | Hosts the agents' shell commands and tests may reach. None by default |
| `sandbox.allowRead` | Folders outside the worktree that your tools must read. The rest of the home folder is denied |
| `policy` | The paths that make a pull request high risk, and the size limits |

Agents may run the lint, type-check and test commands. They may not run the install, sync or start commands, add packages, commit, push, call `gh` or write to the tracker. The factory does those things.

Environment variables override the file. They also set where the factory keeps its own data:

| Variable | Default | Purpose |
| --- | --- | --- |
| `FACTORY_REPO` | the git root of the current folder | The repository the factory works on |
| `FACTORY_CONFIG` | `factory.config.json` in that repository | A config file kept somewhere else |
| `FACTORY_HOME` | `~/.factory/<repo name>` | The factory's state for this repository |
| `FACTORY_DB` | `$FACTORY_HOME/factory.duckdb` | The database |
| `FACTORY_ARTIFACTS` | `$FACTORY_HOME/artifacts` | Screenshots, logs, traces and reports |
| `FACTORY_AUTOSTART` | off | `1` starts the loop when the server starts |
| `FACTORY_CLAUDE_COMMAND` | `claude` | The command for agent runs |
| `FACTORY_CHROMIUM` | Playwright's Chromium | The browser for the browser check |
| `FACTORY_BROWSER_PROFILE` | the config's `app.browserProfile` | A signed-in Chrome profile for the browser check |
| `FACTORY_POLICY` | the config's `policy` | A separate policy file |
| `FACTORY_BASE`, `FACTORY_REMOTE`, `FACTORY_PROJECT_DIR`, `FACTORY_MAX_ATTEMPTS` | the config | Override single fields |
| `FACTORY_INSTALL`, `FACTORY_SYNC`, `FACTORY_LINT`, `FACTORY_TYPECHECK`, `FACTORY_TEST` | the config | Override single commands |
| `FACTORY_ENV_START`, `FACTORY_ENV_HEALTH`, `FACTORY_BROWSER_URL` | the config | Override the app settings |
| `FACTORY_INTAKE_POLL_MS`, `FACTORY_CONDUCTOR_MS` | `0` (off) | The built-in PM intake and conductor agent |
| `FACTORY_URL`, `FACTORY_ACTOR` | `http://127.0.0.1:8787`, `human` | Used by the CLI |
| `API_PORT` | `8787` | The API's port |

Run one factory server per repository; each repository gets its own `~/.factory/<repo name>/`. To work on two repositories at once, start a second server with its own `FACTORY_REPO` and `API_PORT`, and its dashboard with the same `API_PORT` (and `pnpm dev --port <port>`). Point the CLI at it with `FACTORY_URL`.

### Running the factory on a remote machine

You can run the factory on a server instead of your laptop, for example a team build machine that keeps working when your laptop is closed. You drive it with the CLI over SSH, and open the dashboard through a Cloudflare quick tunnel, behind a password.

On the server:

1. Install the factory as in [Getting started](#getting-started). On Linux, also install `bubblewrap` and `socat` for the sandbox. Chromium needs some system libraries: run `pnpm exec playwright install-deps chromium`, or, without root, `bin/setup-browser-libs` once and prefix browser commands with `bin/with-browser-libs` (see `claude.md`).
2. Log in to the tools the factory uses, as the user that will run it: `gh auth login`, and `claude` for Claude Code. For Jira or Linear, add the MCP server and sign in with `/mcp`. Sign-in opens a web page, so the server needs a way to open one, or a way to finish the sign-in from your own browser; how Claude Code handles this on a machine with no browser is not covered here.
3. Run `factory init` in a clone of your repository on the server.
4. Start the factory in a session that outlives your SSH connection, such as `tmux`, with a password for the dashboard:

   ```sh
   FACTORY_REPO=/srv/your-app pnpm factory:server        # API and orchestrator
   pnpm build && DASHBOARD_PASSWORD=<secret> pnpm preview   # dashboard on :4173, behind the password
   cloudflared tunnel --url http://localhost:4173          # prints a https://<words>.trycloudflare.com address
   ```

   `pnpm dev` also works, on port 5173. `pnpm preview` serves the built dashboard, which suits a server that runs for days.
5. Open the `trycloudflare.com` address in your browser and log in as `factory` with the password.

Things to know:

- The API listens on 127.0.0.1 only and has no password of its own. The browser reaches it through the dashboard's proxy, so the same password protects it. Never run a tunnel without `DASHBOARD_PASSWORD`; without it, the dashboard also refuses tunnel hosts.
- A quick tunnel gets a new random address each time `cloudflared` starts. For a fixed address on your own domain, use a named Cloudflare tunnel; the dashboard then needs that host name added to `allowedHosts` in `vite.config.ts`, which accepts only `*.trycloudflare.com` today.
- Run the CLI on the server, over SSH: `factory status`, `factory add --ticket ...`. Or point a local CLI at the server's API through an SSH port forward, with `FACTORY_URL`.
- A signed-in browser check (`app.browserProfile`) needs a Chrome profile in which a person signed in to the app. Make it on the server itself: Chrome protects a profile's saved sign-in with the operating system's key store, so a profile copied from another machine is unlikely to keep its sign-in (untested). On a server with no screen, signing in needs a remote desktop or similar. Without a profile, the check runs signed out.
- Agent runs spend money on the account `claude` is logged in to on the server.

## Developing the factory

The factory can work on its own code: this repository has its own `factory.config.json`.

```sh
pnpm verify      # lint, type check, unit tests, browser tests: must pass before any change is handed over
pnpm lint        # oxlint --deny-warnings
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest
pnpm e2e         # playwright, headless Chromium
pnpm factory:seed --reset   # a dev database with a demo task
```

The rules for people and agents working on this code are in `claude.md`.
