/**
 * The real side effects behind `Effects`: git worktrees, the gate against the merge base,
 * GitHub through `gh`, and the local app as a process group. The orchestrator never shells out itself.
 *
 * Every command runs through `run()` with an argument list (no shell), in the task's project folder.
 * Paths in diffs are relative to the project folder, so the risk policy and locked files use the same paths.
 */
import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { Task } from "../shared/api";
import type { FileChange } from "../shared/risk";
import { runClaude } from "./claude";
import type { EnvController, Effects, GateResult, GateStep, PrStatus, VerifyRun } from "./orchestrator";
import { LOCKFILES } from "../shared/config";
import { Lock } from "./lock";

export interface EffectsConfig {
  /** Git repository root (the one the factory makes worktrees of). */
  repo: string;
  /** The project's folder inside the repository, e.g. "app" ("" for the root). */
  projectDir: string;
  remote: string;
  /** The branch tasks start from and PRs target. */
  base: string;
  /** Where task worktrees and the base worktree live (outside the repository). */
  home: string;
  claudeCommand: string[];
  /** The approved learnings every run reads, per repository. */
  learningsFile?: string;
  installCommand: string[];
  /** Install after a change to package.json or the lockfile; agents may not install packages themselves. */
  syncCommand: string[];
  /** Null skips the lint step. */
  lintCommand: string[] | null;
  typecheckCommand: string[];
  testCommand: string[];
  /** Default "vitest". */
  testRunner?: "vitest" | "jest";
  env: { start: string[] | null; healthUrls: string[]; logLines: number };
}

export type RunResult = { code: number; stdout: string; stderr: string };

/**
 * The HTTP status of `url`, or 599 when it does not answer. Local dev servers often use self-signed
 * certificates, so the certificate is not checked: this only asks whether the app is up.
 */
function statusOf(url: string): Promise<number> {
  const u = new URL(url);
  const get = u.protocol === "https:" ? httpsGet : httpGet;
  return new Promise((done) => {
    const req = get(u, { timeout: 3000, rejectUnauthorized: false }, (res) => {
      res.resume();
      done(res.statusCode ?? 599);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => done(599));
  });
}

/** A change to one of these files makes the gate reinstall dependencies first. */
const DEPENDENCY_FILE = new RegExp(`(^|/)(${["package.json", "pnpm-workspace.yaml", ...Object.values(LOCKFILES)].map((f) => f.replace(/\./g, "\\.")).join("|")})$`);

/** Run a command without a shell. Never throws on a non-zero exit; `NODE_OPTIONS` is dropped. */
export function run(cmd: string[], cwd: string, opts: { timeoutMs?: number; env?: Record<string, string> } = {}): Promise<RunResult> {
  const [bin, ...args] = cmd;
  if (!bin) return Promise.resolve({ code: 127, stdout: "", stderr: "empty command" });
  const { NODE_OPTIONS: _ignored, ...env } = process.env;
  return new Promise((done) => {
    execFile(bin, args, { cwd, env: { ...env, CI: "1", ...opts.env }, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs ?? 20 * 60_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      done({ code, stdout: String(stdout), stderr: error && !stderr ? String(error.message) : String(stderr) });
    });
  });
}

async function must(cmd: string[], cwd: string, opts?: { timeoutMs?: number }): Promise<string> {
  const r = await run(cmd, cwd, opts);
  if (r.code !== 0) throw new Error(`${cmd.join(" ")} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-1500)}`);
  return r.stdout.trim();
}

const tail = (text: string, chars = 3000) => (text.length > chars ? `...${text.slice(-chars)}` : text);

/* ------------------------------ Type errors ------------------------------ */

export type TypeError = { file: string; code: string; message: string; line: string };

/** Parse `tsc --pretty false` output. Paths are made relative to `root`. */
export function parseTypeErrors(output: string, cwd: string, root: string): TypeError[] {
  const errors: TypeError[] = [];
  for (const line of output.split("\n")) {
    const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line.trim());
    if (!m) continue;
    const file = relative(root, resolve(cwd, m[1]!));
    errors.push({ file, code: m[4]!, message: m[5]!, line: `${file}(${m[2]},${m[3]}): error ${m[4]}: ${m[5]}` });
  }
  return errors;
}

/** Errors match without line and column, because the change moves lines. */
const errorKey = (e: TypeError) => `${e.file}|${e.code}|${e.message}`;

export function newTypeErrors(task: TypeError[], base: TypeError[]): TypeError[] {
  const seen = new Map<string, number>();
  for (const e of base) seen.set(errorKey(e), (seen.get(errorKey(e)) ?? 0) + 1);
  return task.filter((e) => {
    const n = seen.get(errorKey(e)) ?? 0;
    if (n > 0) {
      seen.set(errorKey(e), n - 1);
      return false;
    }
    return true;
  });
}

/** Errors a test written first may have: the code under test does not exist yet. */
const NOT_YET = new Set(["TS2339", "TS2353", "TS2305", "TS2551", "TS2554", "TS2555", "TS2614", "TS2724"]);
export function isNotYetImplemented(e: TypeError): boolean {
  if (NOT_YET.has(e.code)) return true;
  return e.code === "TS2307" && /['"]\.\.?\//.test(e.message);
}

/** Escape hatches added by a diff: counted per kind, added minus removed. */
const HATCHES: Array<[string, RegExp]> = [
  ["as any", /\bas any\b/g],
  [": any", /:\s*any\b/g],
  ["@ts-ignore", /@ts-ignore/g],
  ["@ts-expect-error", /@ts-expect-error/g],
  ["@ts-nocheck", /@ts-nocheck/g],
  ["lint disable", /(oxlint|eslint)-disable/g],
];
export function addedHatches(unifiedDiff: string): string[] {
  const counts = new Map<string, number>();
  for (const line of unifiedDiff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    const sign = line.startsWith("+") ? 1 : line.startsWith("-") ? -1 : 0;
    if (!sign) continue;
    for (const [name, re] of HATCHES) counts.set(name, (counts.get(name) ?? 0) + sign * (line.match(re)?.length ?? 0));
  }
  return [...counts].filter(([, n]) => n > 0).map(([name, n]) => `${n} more \`${name}\``);
}

/* ------------------------------ Diff parsing ------------------------------ */

export function parseDiff(nameStatus: string, numstat: string): FileChange[] {
  const lines = new Map<string, { added: number; removed: number }>();
  for (const row of numstat.split("\n").filter(Boolean)) {
    const [a, r, ...rest] = row.split("\t");
    const path = rest.at(-1)!;
    lines.set(path, { added: Number(a) || 0, removed: Number(r) || 0 });
  }
  const changes: FileChange[] = [];
  for (const row of nameStatus.split("\n").filter(Boolean)) {
    const [status, ...paths] = row.split("\t");
    const path = paths.at(-1)!;
    const kind = status?.startsWith("A") ? "added" : status?.startsWith("D") ? "deleted" : "modified";
    if (status?.startsWith("R") && paths[0]) changes.push({ path: paths[0], status: "deleted", added: 0, removed: 0 });
    changes.push({ path, status: kind, ...(lines.get(path) ?? { added: 0, removed: 0 }) });
  }
  return changes;
}

/* ------------------------------ The effects ------------------------------ */

export function createEffects(config: EffectsConfig): Effects {
  const baseRef = `${config.remote}/${config.base}`;
  const project = (root: string) => join(root, config.projectDir);
  const baseRoot = join(config.home, "base");

  async function mergeBase(cwd: string): Promise<string> {
    return must(["git", "merge-base", "HEAD", baseRef], cwd);
  }

  // Tasks run in parallel. Writes to the shared repository's refs and worktree list (fetch, worktree add, push)
  // take turns, and so does the one merge-base checkout: from checking out a commit until its user is finished.
  const gitLock = new Lock();
  const baseLock = new Lock();
  const git = (args: string[], cwd: string) => gitLock.run(() => must(["git", ...args], cwd));

  /** Runs `fn` on the merge-base checkout at `sha`, holding it so no other task checks out another commit meanwhile. */
  function withBase<T>(sha: string, fn: (dir: string) => Promise<T>): Promise<T> {
    return baseLock.run(async () => fn(await prepareBase(sha)));
  }

  /** The shared base worktree, detached on `sha`, with dependencies installed when the lockfile changed. Self-repairs. Call it through `withBase`. */
  async function prepareBase(sha: string): Promise<string> {
    if (existsSync(baseRoot) && !existsSync(join(baseRoot, ".git"))) rmSync(baseRoot, { recursive: true, force: true });
    if (!existsSync(baseRoot)) {
      mkdirSync(config.home, { recursive: true });
      await gitLock.run(async () => {
        await run(["git", "worktree", "prune"], config.repo);
        await must(["git", "worktree", "add", "--detach", baseRoot, sha], config.repo);
      });
    } else {
      await must(["git", "checkout", "--detach", "--force", sha], baseRoot);
    }
    const dir = project(baseRoot);
    // Install only when the lockfile at this commit differs from the last install (the first build takes minutes).
    const stamp = join(baseRoot, ".factory-installed");
    const hashes = await Promise.all(Object.values(LOCKFILES).map(async (f) => (await run(["git", "rev-parse", `${sha}:${join(config.projectDir, f)}`], baseRoot)).stdout.trim()));
    // The install command is part of the stamp: a new command (such as a different store layout) needs a fresh install.
    const want = `${hashes.filter(Boolean).join(",") || "none"}|${config.installCommand.join(" ")}`;
    if (!existsSync(stamp) || readFileSync(stamp, "utf8") !== want) {
      await must(config.installCommand, dir, { timeoutMs: 30 * 60_000 });
      writeFileSync(stamp, want);
    }
    return dir;
  }

  async function typeErrors(cwd: string): Promise<{ ok: boolean; errors: TypeError[]; output: string }> {
    const r = await run(config.typecheckCommand, cwd);
    const output = `${r.stdout}\n${r.stderr}`;
    return { ok: r.code === 0, errors: parseTypeErrors(output, cwd, cwd), output };
  }

  // Jest's JSON report has the same testResults shape as Vitest's; only the flags differ.
  const runner =
    config.testRunner === "jest"
      ? { changed: (base: string) => [`--changedSince=${base}`], report: (file: string) => ["--json", `--outputFile=${file}`] }
      : { changed: (base: string) => ["--changed", base], report: (file: string) => ["--reporter=default", "--reporter=json", `--outputFile.json=${file}`] };

  async function failingTestFiles(cwd: string, args: string[]): Promise<{ ok: boolean; failed: string[]; output: string }> {
    const scratch = mkdtempSync(join(tmpdir(), "factory-vitest-"));
    const report = join(scratch, "report.json");
    const r = await run([...config.testCommand, ...args, ...runner.report(report)], cwd);
    let failed: string[] = [];
    try {
      const json = JSON.parse(readFileSync(report, "utf8")) as { testResults?: Array<{ name: string; status: string }> };
      // Report paths are real paths; resolve both sides before comparing.
      const root = realpathSync(cwd);
      failed = (json.testResults ?? []).filter((t) => t.status !== "passed").map((t) => relative(root, realpathSync(t.name)));
    } catch {
      if (r.code !== 0) failed = ["(the test run produced no report)"];
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    return { ok: r.code === 0, failed, output: `${r.stdout}\n${r.stderr}` };
  }

  const env: EnvController = {
    start(worktree, logPath) {
      if (!config.env.start) throw new Error("No local app is configured (FACTORY_ENV_START), so the browser check cannot run.");
      const [bin, ...args] = config.env.start;
      const fd = openSync(logPath, "a");
      const { NODE_OPTIONS: _ignored, ...parentEnv } = process.env;
      // Its own process group, so stop() can signal every process it starts.
      const child = spawn(bin!, args, { cwd: worktree, detached: true, stdio: ["ignore", fd, fd], env: parentEnv });
      closeSync(fd);
      child.unref();
      if (!child.pid) throw new Error(`Could not start ${config.env.start.join(" ")}`);
      return child.pid;
    },
    async isUp() {
      if (config.env.healthUrls.length === 0) return false;
      for (const url of config.env.healthUrls) {
        if ((await statusOf(url)) >= 500) return false;
      }
      return true;
    },
    isRunning(pid) {
      try {
        process.kill(-pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    async stop(pid) {
      const alive = () => env.isRunning(pid);
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        return;
      }
      for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 200));
      if (alive()) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    },
    async portHolders() {
      const ports = [...new Set(config.env.healthUrls.map((u) => Number(new URL(u).port || (u.startsWith("https") ? 443 : 80))))];
      const holders: Array<{ port: number; pid: number; command: string }> = [];
      for (const port of ports) {
        // -F: one field per line, p<pid> then c<command>.
        const r = await run(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], config.repo);
        let pid = 0;
        for (const line of r.stdout.split("\n")) {
          if (line.startsWith("p")) pid = Number(line.slice(1));
          else if (line.startsWith("c") && pid) holders.push({ port, pid, command: line.slice(1) });
        }
      }
      return holders;
    },
    logTail(logPath) {
      if (!existsSync(logPath)) return "(no log)";
      return readFileSync(logPath, "utf8").split("\n").slice(-config.env.logLines).join("\n");
    },
  };

  return {
    claude: (call, opts) => runClaude(call, { cwd: opts.cwd, runDir: opts.runDir, env: opts.env, command: config.claudeCommand, learningsFile: config.learningsFile }),

    async createWorktree(task: Task) {
      const key = task.ticketKey?.replace(/^#/, "issue-").replace(/[^A-Za-z0-9-]+/g, "-").toLowerCase();
      const slug = (key ? `${key}-` : "") + task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
      const branch = `factory/${slug || task.id.slice(0, 8)}-${task.id.slice(0, 6)}`;
      const root = join(config.home, "worktrees", task.id);
      await git(["fetch", config.remote, config.base], config.repo);
      if (!existsSync(join(root, ".git"))) {
        rmSync(root, { recursive: true, force: true });
        mkdirSync(join(config.home, "worktrees"), { recursive: true });
        await gitLock.run(async () => {
          await run(["git", "worktree", "prune"], config.repo);
          await must(["git", "worktree", "add", "-B", branch, root, baseRef], config.repo);
        });
      }
      // A new worktree has no dependencies, so tests and hooks would fail.
      await must(config.installCommand, project(root), { timeoutMs: 30 * 60_000 });
      return { branch, worktree: project(root) };
    },

    fileExists: (worktree, path) => existsSync(join(worktree, path)),

    async withBaseCheckout(worktree, fn) {
      return withBase(await mergeBase(worktree), fn);
    },

    async untrackedFiles(worktree) {
      const out = await must(["git", "ls-files", "--others", "--exclude-standard"], worktree);
      return out.split("\n").map((l) => l.trim()).filter(Boolean);
    },

    async verifyInBrowser({ baseUrl, entry, units, outDir }) {
      // The factory's own Playwright and Chromium (pnpm exec playwright install chromium).
      const { chromium } = await import("@playwright/test");
      const browser = await chromium.launch({ headless: true });
      type Handle = { manifest(): Array<{ unitId: string; fixtures: Array<{ id: string; route: string }> }>; current(): { verdict: VerifyRun["verdict"]; checks: Array<{ status: string; label: string; detail?: string }>; blockedReason?: string } | null };
      try {
        const page = await browser.newPage({ ignoreHTTPSErrors: true });
        await page.goto(new URL(entry, baseUrl).toString());
        await page.waitForFunction(() => Boolean((globalThis as unknown as { __verify?: unknown }).__verify), null, { timeout: 30_000 });
        const manifest = await page.evaluate(() => (globalThis as unknown as { __verify: Handle }).__verify.manifest());
        const results: VerifyRun[] = [];
        for (const unit of manifest.filter((m) => units.includes(m.unitId))) {
          for (const fixture of unit.fixtures) {
            const route = `${fixture.route}${fixture.route.includes("?") ? "&" : "?"}chrome=0`;
            await page.goto(new URL(route, baseUrl).toString());
            const done = await page.waitForSelector("body[data-verify-verdict]", { timeout: 15_000 }).then(() => true, () => false);
            const current = done ? await page.evaluate(() => (globalThis as unknown as { __verify: Handle }).__verify.current()) : null;
            const screenshot = `${unit.unitId}--${fixture.id}.png`.replace(/[^\w.-]+/g, "-");
            await page.screenshot({ path: join(outDir, screenshot), fullPage: true });
            results.push({
              unit: unit.unitId,
              fixture: fixture.id,
              verdict: current?.verdict ?? "BLOCKED",
              failures: current
                ? [...(current.blockedReason ? [current.blockedReason] : []), ...current.checks.filter((c) => c.status === "fail").map((c) => `${c.label}${c.detail ? `: ${c.detail}` : ""}`)]
                : ["the fixture page never reported a verdict"],
              screenshot,
            });
          }
        }
        return { results, missing: units.filter((u) => !manifest.some((m) => m.unitId === u)) };
      } finally {
        await browser.close();
      }
    },

    async fetchIssue(cwd, key) {
      const number = key.replace(/^#/, "");
      const raw = await must(["gh", "issue", "view", number, "--json", "title,body,url,author,comments"], cwd);
      const issue = JSON.parse(raw) as { title: string; body: string; url: string; author?: { login?: string }; comments?: Array<{ author?: { login?: string }; body: string }> };
      return {
        title: issue.title,
        body: issue.body,
        url: issue.url,
        author: issue.author?.login ?? "someone",
        comments: (issue.comments ?? []).map((c) => ({ author: c.author?.login ?? "someone", body: c.body })),
      };
    },

    async diff(worktree) {
      await must(["git", "add", "-A", "."], worktree);
      const mb = await mergeBase(worktree);
      const [names, nums] = await Promise.all([
        must(["git", "diff", "--cached", "--relative", "--name-status", "-M", mb], worktree),
        must(["git", "diff", "--cached", "--relative", "--numstat", "-M", mb], worktree),
      ]);
      return parseDiff(names, nums);
    },

    async gate(worktree, changes) {
      const steps: GateStep[] = [];
      const present = changes.filter((c) => c.status !== "deleted").map((c) => c.path);
      if (changes.some((c) => DEPENDENCY_FILE.test(c.path))) {
        const r = await run(config.syncCommand, worktree, { timeoutMs: 30 * 60_000 });
        steps.push({ name: "install", ok: r.code === 0, output: r.code === 0 ? "" : tail(`${r.stdout}\n${r.stderr}`) });
        if (r.code !== 0) return { ok: false, steps };
      }

      // Lint: any lint error in a changed script file fails (not compared with the base).
      const scripts = present.filter((p) => /\.(c|m)?(t|j)sx?$/.test(p));
      if (scripts.length && config.lintCommand) {
        const r = await run([...config.lintCommand, ...scripts], worktree);
        steps.push({ name: "lint", ok: r.code === 0, output: tail(`${r.stdout}\n${r.stderr}`) });
      }

      // Escape hatches the change adds.
      const mb = await mergeBase(worktree);
      const hatches = addedHatches(await must(["git", "diff", "--cached", "--relative", mb], worktree));
      steps.push({ name: "escape hatches", ok: hatches.length === 0, output: hatches.length ? `The change adds: ${hatches.join(", ")}.` : "" });

      // Types: only errors that are not already on the merge base count, shown without the base's.
      const types = await typeErrors(worktree);
      if (types.ok) steps.push({ name: "typecheck", ok: true, output: "" });
      else if (types.errors.length === 0) steps.push({ name: "typecheck", ok: false, output: tail(types.output) }); // failed without parseable errors
      else {
        const baseErrors = await withBase(mb, async (baseDir) => (await typeErrors(baseDir)).errors);
        const fresh = newTypeErrors(types.errors, baseErrors);
        const output = fresh.slice(0, 30).map((e) => e.line).join("\n") + (fresh.length > 30 ? `\n... and ${fresh.length - 30} more` : "");
        steps.push({ name: "typecheck", ok: fresh.length === 0, output });
      }

      // Tests related to the change; a failing file counts only if it passes on the merge base.
      const tests = await failingTestFiles(worktree, runner.changed(mb));
      if (tests.ok) steps.push({ name: "tests", ok: true, output: "" });
      else {
        const baseRun = await withBase(mb, async (baseDir) => {
          const onBase = tests.failed.filter((f) => existsSync(join(baseDir, f)));
          return onBase.length ? await failingTestFiles(baseDir, onBase) : { failed: [] as string[] };
        });
        const fresh = tests.failed.filter((f) => !baseRun.failed.includes(f));
        steps.push({ name: "tests", ok: fresh.length === 0, output: fresh.length ? `Failing: ${fresh.join(", ")}\n${tail(tests.output)}` : "" });
      }
      return { ok: steps.every((s) => s.ok), steps } satisfies GateResult;
    },

    async typecheckTests(worktree, files) {
      const types = await typeErrors(worktree);
      if (types.ok) return { ok: true, steps: [{ name: "typecheck", ok: true, output: "" }] };
      const wanted = new Set(files);
      const faults = types.errors.filter((e) => wanted.has(e.file) && !isNotYetImplemented(e));
      return {
        ok: faults.length === 0,
        steps: [{ name: "typecheck", ok: faults.length === 0, output: faults.slice(0, 30).map((e) => e.line).join("\n") }],
      };
    },

    async runTests(worktree, files) {
      const r = await run([...config.testCommand, ...files], worktree);
      return { ok: r.code === 0, output: tail(`${r.stdout}\n${r.stderr}`) };
    },

    async commitAndPush(worktree, branch, message, force) {
      await must(["git", "add", "-A", "."], worktree);
      const staged = await run(["git", "diff", "--cached", "--quiet"], worktree);
      if (staged.code !== 0) await must(["git", "commit", "--no-verify", "-m", message], worktree);
      // After a move onto the base the branch no longer contains the remote commits; the lease refuses the
      // push if someone else pushed in the meantime.
      await git(["push", ...(force ? ["--force-with-lease"] : []), "-u", config.remote, `HEAD:refs/heads/${branch}`], worktree);
    },

    async syncWithBase(worktree) {
      await git(["fetch", config.remote, config.base], worktree);
      const mb = await mergeBase(worktree);
      const tip = await must(["git", "rev-parse", baseRef], worktree);
      if (mb === tip) return { upToDate: true, conflicts: [] };
      const root = await must(["git", "rev-parse", "--show-toplevel"], worktree);
      await must(["git", "add", "-A", "."], worktree);
      const scratch = mkdtempSync(join(tmpdir(), "factory-sync-"));
      const patch = join(scratch, "change.patch");
      try {
        // The task's own change since the merge base, as one patch, applied with a three-way merge.
        // Untrimmed: a patch without its final newline is corrupt.
        const diff = await run(["git", "diff", "--cached", "--binary", mb, "--", config.projectDir || "."], root);
        if (diff.code !== 0) throw new Error(`git diff failed: ${diff.stderr.slice(-800)}`);
        writeFileSync(patch, diff.stdout);
        const before = await must(["git", "rev-parse", "HEAD"], root);
        await must(["git", "reset", "--hard", baseRef], root);
        if (!diff.stdout.trim()) return { upToDate: false, conflicts: [] };
        const applied = await run(["git", "apply", "--3way", "--index", patch], root);
        const conflicts = (await must(["git", "diff", "--name-only", "--relative", "--diff-filter=U"], worktree)).split("\n").filter(Boolean);
        if (applied.code !== 0 && conflicts.length === 0) {
          // Not a conflict: put the change back exactly where it was, and stop.
          await must(["git", "reset", "--hard", before], root);
          await must(["git", "apply", "--index", patch], root);
          throw new Error(`Could not move the change onto ${baseRef}: ${(applied.stderr || applied.stdout).trim().slice(-800)}`);
        }
        return { upToDate: false, conflicts };
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },

    async createPr(worktree, branch, title, body) {
      const scratch = mkdtempSync(join(tmpdir(), "factory-pr-"));
      const file = join(scratch, "body.md");
      writeFileSync(file, body);
      try {
        // Name the head branch explicitly.
        // A draft: the factory marks it ready once CI is green.
        const url = await must(["gh", "pr", "create", "--draft", "--base", config.base, "--head", branch, "--title", title, "--body-file", file], worktree);
        const n = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
        if (!n) throw new Error(`gh pr create gave no PR number: ${url}`);
        return n;
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },

    async updatePrBody(worktree, pr, body) {
      const scratch = mkdtempSync(join(tmpdir(), "factory-pr-"));
      const file = join(scratch, "body.md");
      writeFileSync(file, body);
      try {
        await must(["gh", "pr", "edit", String(pr), "--body-file", file], worktree);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },

    async prStatus(worktree, pr): Promise<PrStatus> {
      const raw = await must(["gh", "pr", "view", String(pr), "--json", "state,isDraft,headRefOid,mergeable,statusCheckRollup,reviews"], worktree);
      return parsePrStatus(raw);
    },

    // The factory adds no labels: it does not create labels in someone else's repository. The risk is in the footer.
    async setReady(worktree, pr, ready) {
      await must(["gh", "pr", "ready", String(pr), ...(ready ? [] : ["--undo"])], worktree).catch((error: Error) => {
        // Already in the wanted state is fine.
        if (!/already|is not a draft|is a draft/i.test(error.message)) throw error;
      });
    },

    env,
  };
}

export function parsePrStatus(raw: string): PrStatus {
  const view = JSON.parse(raw) as {
    state: string;
    isDraft?: boolean;
    headRefOid: string;
    mergeable?: string;
    statusCheckRollup?: Array<{ name?: string; context?: string; status?: string; conclusion?: string; state?: string }>;
    reviews?: Array<{ state: string; body?: string; submittedAt?: string; author?: { login?: string } }>;
  };
  const state = view.state === "MERGED" ? "MERGED" : view.state === "CLOSED" ? "CLOSED" : "OPEN";
  const changesRequested = (view.reviews ?? [])
    .filter((r) => r.state === "CHANGES_REQUESTED")
    .map((r) => ({ at: r.submittedAt ?? "", by: r.author?.login ?? "a reviewer", body: (r.body ?? "").trim() || "(no comment)" }));
  const base = { state, isDraft: Boolean(view.isDraft), headSha: view.headRefOid, changesRequested, conflicting: view.mergeable === "CONFLICTING" } as const;
  const checks = view.statusCheckRollup ?? [];
  const name = (c: (typeof checks)[number]) => c.name ?? c.context ?? "check";
  const failures = checks.filter((c) => ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "ERROR"].includes(c.conclusion ?? c.state ?? "")).map(name);
  if (failures.length) return { ...base, checks: "fail", failures };
  const pending = checks.some((c) => (c.status && c.status !== "COMPLETED") || c.state === "PENDING" || c.state === "EXPECTED");
  if (pending || view.mergeable === "UNKNOWN") return { ...base, checks: "pending", failures: [] };
  return { ...base, checks: "pass", failures: [] };
}
