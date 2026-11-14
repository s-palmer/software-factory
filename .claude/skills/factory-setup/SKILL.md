---
name: factory-setup
description: "Set up a repository for the software factory: choose the ticket system (GitHub, Jira, Linear), write and tune factory.config.json, add and sign in to the tracker's MCP server, fix what the checks report, and start the factory. Use when someone wants to start using the factory on a repository."
---

# Set up a repository for the software factory

You help a person point the factory at their repository. `factory init` does the deterministic work; you fill in what it cannot know, and you walk the person through the steps only they can do. Ask before every change outside `factory.config.json`, and before any push.

The factory folder is the folder that holds this skill (two levels above `.claude/skills/factory-setup/`). Run the CLI as `<factory folder>/bin/factory`.

## 1. Choose

Ask the person, in one question each:

1. **The repository.** A path to a git repository with a GitHub remote. Default: the current git repository, if it is not the factory folder.
2. **Where tickets live.** `github` (issues in the same repository), `jira` or `linear`. For another tracker, choose the closest and change `tracker` by hand in step 3.

## 2. Run init

```sh
<factory folder>/bin/factory init --yes --json --repo <repo> --tracker <github|jira|linear>
```

Add `--force` only if the person agrees to replace an existing `factory.config.json`. The JSON has `config`, `checks` (each with `ok` and `detail`) and `mcpSetup`.

## 3. Tune factory.config.json

Read the repository's `package.json`, its README and its CI config, then check each field and change what is wrong. Show the person each change.

| Field | What to check |
| --- | --- |
| `commands.test` | Must run Vitest. In a monorepo, the command that runs the app's tests from `projectDir` |
| `commands.typecheck` | Must print `tsc` errors. A project script that wraps `tsc --noEmit` is fine |
| `commands.lint` | Gets the changed files appended, so it must accept file paths. Remove it if no linter exists |
| `app.start`, `app.url`, `app.healthUrls` | The command that starts the app locally and the URL it answers on. Without `start`, any visible change escalates at the browser check |
| `sandbox.allowedDomains` | Hosts the tests must reach (agents' shell commands have no network otherwise) |
| `sandbox.allowRead` | Folders outside the worktree the tools must read, if a test run fails with `EPERM` |
| `projectDir` | The app's folder in a monorepo, `""` otherwise |
| `verify.enabled` | Runtime verification for React UI. If on, check that `verify.html` loads on the dev server and that `react`, `react-dom`, `zod` and `jsdom` are installed |
| `policy.alwaysHuman` | Add the repository's sensitive paths (auth, payments, infrastructure, migrations) |

## 4. The tracker's MCP server (Jira, Linear)

Skip this for `github`: the factory reads issues with `gh`.

Agents read tickets through the MCP server named in `tracker.name`, with the sign-in the person made in Claude Code. `mcpSetup` in the init output has the exact commands.

1. Check it: `claude mcp get <name>`. Done when it prints the tracker's URL and `Status: ✔ Connected`.
2. If it is missing, ask the person, then run the `claude mcp add --scope user ...` command from `mcpSetup`.
3. Signing in needs the person: ask them to type `/mcp` in this session, choose the server and sign in in the browser. You cannot do this for them.
4. Check again with `claude mcp get <name>`.

## 5. Fix the other checks

Run `factory init --yes --json --repo <repo>` again (without `--force`, so the config stays) and go through each check with `ok: false`. Its `detail` says how to fix it. These need the person: `gh auth login`, installing Claude Code, and on Linux installing `bubblewrap` and `socat` for the sandbox. Ask before you push the base branch or commit the config.

## 6. Start

Tell the person to commit `factory.config.json`, then, in the factory folder:

```sh
FACTORY_REPO=<repo> pnpm factory:server   # API and orchestrator; the loop starts paused
pnpm dev                                  # dashboard on http://localhost:5173
```

Then `factory add --ticket <key>` and `factory start`. The dashboard's Environment page shows the local app and the task that runs it.

Do not start the loop yourself: agent runs cost money, and the person decides when.
