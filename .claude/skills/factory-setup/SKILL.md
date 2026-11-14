---
name: factory-setup
description: "Set up a repository for the software factory: choose the ticket system (GitHub, Jira, Linear), write and tune factory.config.json, add and sign in to the tracker's MCP server, fix what the checks report, and start the factory. Use when someone wants to start using the factory on a repository."
---

# Set up a repository for the software factory

You help a person point the factory at their repository. `factory init` does the fixed steps. You fill in what it cannot know, and take the person through the steps only they can do. Ask before every change outside `factory.config.json`, and before any push.

The factory folder is the one that holds this skill, two levels above `.claude/skills/factory-setup/`. Run the CLI as `<factory folder>/bin/factory`.

## 1. Choose

Ask the person two questions, one at a time:

1. Which repository? A path to a git repository with a GitHub remote. The default is the current git repository, unless it is the factory folder.
2. Where do the tickets live? `github` (issues in the same repository), `jira` or `linear`. For another tracker, choose the closest one and change `tracker` by hand in step 3.

## 2. Run init

```sh
<factory folder>/bin/factory init --yes --json --repo <repo> --tracker <github|jira|linear>
```

Add `--force` only if the person agrees to replace an existing `factory.config.json`. The JSON has `config`, `checks` (each with `ok` and `detail`) and `mcpSetup`.

## 3. Tune factory.config.json

Read the repository's `package.json`, its README and its CI configuration. Then check each field and change what is wrong. Show the person each change.

| Field | What to check |
| --- | --- |
| `commands.test`, `commands.testRunner` | Runs the unit tests with Vitest or Jest; set `testRunner` to match. In a monorepo, the command that runs the app's tests from `projectDir` |
| `commands.typecheck` | Must print `tsc` errors. A project script that wraps `tsc --noEmit` is fine |
| `commands.lint` | Gets the changed files appended, so it must accept file paths. Remove it if no linter exists |
| `app.start`, `app.url`, `app.healthUrls` | The command that starts the app locally and the URL it answers on. Without `start`, any visible change escalates at the browser check |
| `app.browserProfile` | If the app needs a sign-in, a Chrome profile folder where the person signed in. The README says how to make one; only the person can sign in |
| `sandbox.allowedDomains` | Hosts the tests must reach. Agents' shell commands have no network otherwise |
| `sandbox.allowRead` | Folders outside the worktree the tools must read, if a test run fails with `EPERM` |
| `projectDir` | The app's folder in a monorepo, `""` otherwise |
| `verify.enabled` | Runtime verification for React UI. If on, check that `verify.html` loads on the dev server and that `react`, `react-dom`, `zod` and `jsdom` are installed |
| `skills` | Ask whether the team has its own skills, for example in `.claude/skills/`. If it has, set `skills.dir` and the files for each stage. If not, keep the default, Matt Pocock's skills |
| `policy.alwaysHuman` | Add the repository's sensitive paths: authentication, payments, infrastructure, migrations |

## 4. The tracker's MCP server (Jira, Linear)

Skip this for `github`: the factory reads issues with `gh`.

Agents read tickets through the MCP server named in `tracker.name`, with the sign-in the person made in Claude Code. `mcpSetup` in the init output has the exact commands.

1. Check it with `claude mcp get <name>`. It is ready when that prints the tracker's URL and `Status: ✔ Connected`.
2. If it is missing, ask the person, then run the `claude mcp add --scope user ...` command from `mcpSetup`.
3. Only the person can sign in. Ask them to type `/mcp` in this session, choose the server and sign in in the browser.
4. Check again with `claude mcp get <name>`.

## 5. Fix the other checks

Run `factory init --yes --json --repo <repo>` again, without `--force` so that the config stays, and go through each check with `ok: false`. Its `detail` says how to fix it. Some fixes need the person: `gh auth login`, installing Claude Code, and on Linux installing `bubblewrap` and `socat` for the sandbox. Ask before you push the base branch or commit the config.

## 6. Start

Tell the person to commit `factory.config.json` and then, in the factory folder, run:

```sh
FACTORY_REPO=<repo> pnpm factory:server   # API and orchestrator; the loop starts paused
pnpm dev                                  # dashboard on http://localhost:5173
```

Then `factory add --ticket <key>` and `factory start`. The dashboard's Environment page shows the local app and the task that runs it.

Do not start the loop yourself. Agent runs cost money, and the person decides when to spend it.
