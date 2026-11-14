# Simple Software Factory

Turns tickets into tested pull requests. By default no person is in the loop; a task can ask for a person's sign-off. Point it at a TypeScript repository that uses Vitest or Jest. Tickets can live in GitHub issues, Jira, Linear or any tracker with an MCP server.

Each stage is a headless Claude Code agent. Plain code moves the task between stages and checks every result. The factory never merges: it opens a draft pull request, fixes failing CI and review comments itself, and marks it ready for review. You, or your own merge agent, merge it.

```
ticket -> scoping -> design -> test_writing -> implementing -> reviewing -> browser_check -> pr -> awaiting_merge -> done
                                                                                               (or escalated)
```

## What it does

- **One task per ticket.** `factory add --ticket PROJ-12 --after PROJ-11`. A task starts when its blockers are merged.
- **One agent per stage**, each with its own prompt, tools, budget and model (by default Fable for judgement stages, Opus for building).
- **Checks between stages.** Output must match a schema. Lint, type check and tests are compared with the merge base. New tests must fail before the change, and are then locked.
- **Several tasks at once** (`maxParallelTasks`, default 3). Each has its own worktree; the local app, the merge-base checkout and writes to the shared repository are taken in turn.
- **Failures loop back** to `implementing` with the failure as feedback. Three failures in a row escalate.
- **Autonomous by default, sign-off per task.** A task can stop for a person's approval after scoping (the solution doc), after design (the task list), or both: the Sign-off choice in the New task form, or `factory add --gate design`. Approve goes on; Request changes runs that stage again with your comment. `gates` in the config sets a default for tasks that do not choose.
- **Steering.** Give a running task a note (the Steer panel, or `factory steer`). Every later agent run on the task reads it. "Stop and redo the stage" stops the run in progress and runs the stage again with the note, with no escalation. Pause stops a task taking new steps.
- **No questions to people.** A decider agent answers the agents' questions, and escalates only for money, legal text, security or stored data.
- **A browser check** for visible changes. An agent checks each acceptance criterion in your running app and takes a screenshot. The factory then photographs the same criteria on the base branch, so the dashboard shows each criterion before and after. Screenshots stay with the task and never go into the repository.
- **Isolated agents.** Each agent works in its own git worktree. File tools cannot leave it, and shell commands (including the tests they run) run in Claude Code's sandbox: no reads of the rest of your home folder, and no network unless you allow a host.
- **A risk check.** A change that is too large, or touches a path in the risk policy (tests, dependencies, auth, payments, migrations, CI), is marked high risk in the pull request's description. The factory adds no labels.
- **Optional runtime verification** for React apps: the test agent writes a `.verify.ts` spec for each UI component it changes, checked in jsdom and in the browser.

## How it works

```
your repository                  this folder
factory.config.json --read-->    API + orchestrator (127.0.0.1:8787) <-- dashboard (:5173), factory CLI
                                   +-> ~/.factory/<repo>/: database, artifacts, one git worktree per task
                                   +-> claude -p per stage: skills, sandbox, tracker MCP (read tools only)
                                   +-> Playwright MCP + Chrome for the browser check
                                   +-> gh: issues, branch, draft PR, CI status
```

Your working copy is never touched. Tasks branch from `base` (`main` by default), and their pull requests target it.

## Prerequisites

- Node.js 24+, pnpm 9+, git.
- `gh`, logged in, able to push branches and open pull requests.
- Claude Code 2.1.314+, logged in. Agent runs cost money; each stage has a budget, and `factory status` shows the total.
- On Linux: `bubblewrap` and `socat` for the sandbox.
- For Jira or Linear: the tracker's MCP server, added to Claude Code and signed in.

## Getting started

```sh
git clone <this repository> software-factory && cd software-factory
pnpm install
pnpm exec playwright install chromium
export PATH="$PWD/bin:$PATH"
```

Set up your repository, either from Claude Code in this folder with `/factory-setup`, or in a terminal:

```sh
cd /path/to/your-app
factory init        # asks for the tracker, base branch and how to start the app; writes factory.config.json
```

`init` detects your package manager and test runner, checks `gh`, `claude`, the base branch and the tracker's MCP sign-in, and prints how to fix anything that is missing. For Jira it prints:

```sh
claude mcp add --scope user --transport http jira https://mcp.atlassian.com/v2/mcp   # then /mcp in claude to sign in
```

Linear is the same with `https://mcp.linear.app/mcp/readonly`. Commit `factory.config.json`, or keep it elsewhere and set `FACTORY_CONFIG`. Then, in this folder:

```sh
FACTORY_REPO=/path/to/your-app pnpm factory:server   # the loop starts paused
pnpm dev                                             # dashboard on http://localhost:5173
factory add --ticket PROJ-12 && factory start
```

## Preparing your codebase

The factory can check only what your repository lets it check:

1. **Tests that run headless, with no network.** Set `commands.test`, and `commands.testRunner` to `vitest` or `jest`. If a test needs a host, list it in `sandbox.allowedDomains`.
2. **A type check that prints `tsc` errors** (`commands.typecheck`). A wrapper that prints only counts makes the check weak.
3. **A linter that takes file paths** (`commands.lint`), if you have one.
4. **A way to start the app** for the browser check: `app.start`, `app.url` and `app.healthUrls`, on fixed ports. If the app needs a sign-in, set `app.browserProfile` (below).
5. **A `CLAUDE.md`** with your conventions. Agents load it as a person's session does.
6. **Tickets with acceptance criteria.** The ticket is the spec.
7. **A risk policy** that lists your sensitive paths (`policy.alwaysHuman`).
8. **CI on pull requests** (recommended). The factory waits for green checks, and fixes failures.

## Using it

```sh
factory status | list | show <task> | events --since 0
factory add --ticket PROJ-12 --gate scoping   # stop for your sign-off after scoping
factory approve <task>                    # retry an escalated task, or approve one at a gate
factory changes <task> --comment "..."    # send it back with feedback
factory steer <task> --message "..." [--restart]   # a note for every later run; --restart redoes the stage now
factory pause <task> | unpause <task>
factory stop | start | halt --reason "..."
factory env                               # the local app: up or down, which task runs it, who waits
factory help
```

The dashboard shows each task's progress, working time, cost, agent runs and decisions, and lets you answer escalations. Its before-and-after panel lists each criterion, the base on the left and the change on the right. Copy puts a picture on the clipboard to paste into a pull request comment; Remove deletes it. The Environment page shows the local app and the task using it.

Agents can drive the factory too: [docs/INTERFACE.md](docs/INTERFACE.md) has the CLI contract, exit codes and event feed. With GitHub issues, `factory plan "#7"` turns an idea into a spec, tickets and tasks.

### Skills

Each stage follows skill files. The defaults are [Matt Pocock's skills](https://github.com/mattpocock/skills) (MIT) in `.claude/skills/`: `to-spec` (scoping), `codebase-design` and `domain-modeling` (design), `tdd` (tests), `implement` (code), `code-review` (review) and `pr` (pull request text). To use your own, set `skills.dir` and list the files per stage:

```json
"skills": { "dir": ".claude/skills", "stages": { "reviewing": ["review-checklist/SKILL.md"] } }
```

A stage you list gets your files and the factory's general rules (no questions, no commits, no tracker writes). Stages you do not list keep the default file names.

### Signed-in browser checks

If the app needs a sign-in that a cookie cannot carry, make a Chrome profile and sign in once:

```sh
pnpm exec playwright open --channel chrome --ignore-https-errors --user-data-dir ~/.factory/browser-profile <app url>
```

Close the window, then set `app.browserProfile` to that folder. The browser check then runs in Google Chrome, signed in.

### Runtime verification (React and Vite)

`factory init --verify` copies the verification framework into `src/verify/` and adds a `verify.html` harness page. The test agent then writes `src/verify/specs/<Component>.verify.ts`: fixtures, at least one edge case, and invariants on the rendered DOM. The gate runs the specs in jsdom, and the browser check opens each changed component's fixtures in the app. `src/verify/README.md` explains how to write a spec. Agents cannot edit the framework.

## Configuration

`factory.config.json` at your repository's root. Every field has a default, so `{}` is valid.

| Field | Meaning |
| --- | --- |
| `base`, `remote`, `projectDir` | The branch tasks start from and target; the app's folder in a monorepo |
| `commands.install`, `commands.sync` | Install in a new worktree; reinstall when dependencies change |
| `commands.lint`, `commands.typecheck`, `commands.test`, `commands.testRunner` | The checks. Lint gets file paths; the type check prints `tsc` errors; the runner is `vitest` or `jest` |
| `app.start`, `app.url`, `app.healthUrls`, `app.browserProfile` | How the browser check starts and reaches the app, and an optional signed-in Chrome profile |
| `tracker` | `{ "type": "github" }` or an MCP tracker; `factory init` writes the Jira and Linear presets |
| `skills.dir`, `skills.stages` | Your own skills, per stage |
| `sandbox.allowedDomains`, `sandbox.allowRead` | Hosts and folders the agents' commands may reach |
| `verify` | Runtime verification for React UI |
| `policy`, `maxAttempts` | High-risk paths and size limits; failures before a task escalates |
| `trustedAuthors` | GitHub logins whose issues and comments count as trusted; agents treat others as information only |
| `gates` | Default sign-off for tasks that do not choose: `[]` (autonomous, the default), `"scoping"`, `"design"` |
| `maxParallelTasks` | How many tasks run at once (default 3). One browser check at a time uses the local app; the others wait for it |

Environment variables override single fields: `FACTORY_REPO`, `FACTORY_CONFIG`, `FACTORY_HOME` (default `~/.factory/<repo>`), `FACTORY_BASE`, `FACTORY_TEST`, `FACTORY_BROWSER_PROFILE`, `FACTORY_AUTOSTART=1`, `API_PORT`, and others in `server/config.ts`. The CLI uses `FACTORY_URL` and `FACTORY_ACTOR`.

## Running on a remote machine

Run the factory on a server that keeps working when your laptop is closed, and reach the dashboard through a Cloudflare quick tunnel behind a password:

```sh
FACTORY_REPO=/srv/your-app pnpm factory:server
pnpm build && DASHBOARD_PASSWORD=<secret> pnpm preview   # dashboard on :4173, user "factory"
cloudflared tunnel --url http://localhost:4173          # prints a https://<words>.trycloudflare.com address
```

Run them in `tmux` or similar, and use the CLI over SSH. Notes:

- The API has no password of its own and listens on 127.0.0.1. The dashboard proxies it, so the password covers it. Never run a tunnel without `DASHBOARD_PASSWORD`.
- A quick tunnel gets a new address on each start. A named tunnel on your own domain needs its host added to `allowedHosts` in `vite.config.ts`.
- Log in to `gh`, `claude` and the tracker's MCP server on the server itself, and make any browser profile there too.
- On Linux without root, `bin/setup-browser-libs` installs Chromium's libraries; see `claude.md`.

## Developing the factory

```sh
pnpm verify                  # lint, type check (TypeScript 7, the native compiler), unit and browser tests
pnpm factory:seed --reset    # a dev database with a demo task
```

Rules for people and agents working on this code are in `claude.md`. This repository has its own `factory.config.json`, so the factory can work on itself. To report a security problem, see [SECURITY.md](SECURITY.md).

## Licence

MIT, see [LICENSE](LICENSE). The bundled skills in `.claude/skills/` are Matt Pocock's, also MIT.
