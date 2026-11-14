# Security

## Reporting a vulnerability

Report it privately through GitHub: the repository's **Security** tab, then **Report a vulnerability**. Do not open a public issue.

## What to know before you run the factory

The factory runs AI agents on your machine, with your accounts. Read this before you point it at a repository.

- **Your credentials.** The factory runs `gh`, `git` and `claude` as you. Pull requests are opened, and agent runs are paid for, with your logins.
- **What agents can reach.** Each agent works in its own git worktree. Its file tools cannot leave the worktree, and its shell commands, including the tests they start, run in Claude Code's sandbox: no reads of the rest of your home folder (other projects, `~/.ssh`, `~/.aws`, the factory's own data) and no network unless you allow a host in `sandbox.allowedDomains`. Agents cannot commit, push, call `gh` or write to the tracker; the factory does that. MCP servers (the tracker, the browser) are not sandboxed by Claude Code.
- **The API has no authentication.** It listens on 127.0.0.1 only. Never expose it, or the dashboard, to a network without `DASHBOARD_PASSWORD`, and never run a tunnel without it.
- **Ticket text is untrusted.** Agents are told that tickets, comments, pull requests, web pages and repository files are data, not instructions, and the ticket reaches them between markers that say so. List your team's GitHub logins in `trustedAuthors` so comments from anyone else are marked as information only. These are instructions to a model, not a guarantee; the sandbox is what limits the damage.
- **Secrets do not belong in `factory.config.json`.** It is committed to your repository. Keep tokens for MCP servers in Claude Code's own MCP configuration (`claude mcp add`), not in the `tracker.server` entry.
- **The factory never merges.** A person or your own merge agent decides what reaches your main branch. Changes to sensitive paths are marked high risk; read those before you merge.
- **Screenshots and logs** of your running app are kept in `~/.factory/<repo>/artifacts`. Treat that folder as you treat the app's data.

## Supported versions

Only the latest release gets fixes.
