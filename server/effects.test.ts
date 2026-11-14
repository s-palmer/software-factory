// @vitest-environment node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Task } from "../shared/api";
import { addedHatches, createEffects, isNotYetImplemented, newTypeErrors, parseDiff, parsePrStatus, parseTypeErrors, type EffectsConfig } from "./effects";

describe("parsers", () => {
  it("parse tsc errors relative to the project and match them without line and column", () => {
    const out = "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/b.test.ts(1,10): error TS2305: Module './b' has no exported member 'go'.\nnoise";
    const errors = parseTypeErrors(out, "/p", "/p");
    expect(errors.map((e) => [e.file, e.code])).toEqual([["src/a.ts", "TS2322"], ["src/b.test.ts", "TS2305"]]);
    const moved = parseTypeErrors("src/a.ts(9,1): error TS2322: Type 'string' is not assignable to type 'number'.", "/p", "/p");
    expect(newTypeErrors(errors, moved).map((e) => e.file)).toEqual(["src/b.test.ts"]);
    // Two identical errors on the task, one on the base: one is new.
    expect(newTypeErrors([...moved, ...moved], moved)).toHaveLength(1);
  });

  it("allow only 'not yet implemented' errors in new tests", () => {
    const e = (code: string, message = "x") => ({ file: "t.test.ts", code, message, line: "" });
    expect(isNotYetImplemented(e("TS2339"))).toBe(true);
    expect(isNotYetImplemented(e("TS2307", "Cannot find module './thing' or its corresponding type declarations."))).toBe(true);
    expect(isNotYetImplemented(e("TS2307", "Cannot find module 'left-pad'"))).toBe(false);
    expect(isNotYetImplemented(e("TS2322"))).toBe(false);
  });

  it("count escape hatches the diff adds, net of the ones it removes", () => {
    const diff = ["+++ b/a.ts", "+const x = y as any;", "+// @ts-ignore", "-const z = w as any;", "+ok()"].join("\n");
    expect(addedHatches(diff)).toEqual(["1 more `@ts-ignore`"]);
    expect(addedHatches("+let a: any = 1;")).toEqual(["1 more `: any`"]);
  });

  it("parse a diff into file changes, with renames as delete + add", () => {
    const changes = parseDiff("M\tsrc/a.ts\nA\tsrc/b.ts\nD\tsrc/c.test.ts\nR100\tsrc/old.ts\tsrc/new.ts", "3\t1\tsrc/a.ts\n10\t0\tsrc/b.ts\n0\t7\tsrc/c.test.ts\n0\t0\tsrc/new.ts");
    expect(changes).toEqual([
      { path: "src/a.ts", status: "modified", added: 3, removed: 1 },
      { path: "src/b.ts", status: "added", added: 10, removed: 0 },
      { path: "src/c.test.ts", status: "deleted", added: 0, removed: 7 },
      { path: "src/old.ts", status: "deleted", added: 0, removed: 0 },
      { path: "src/new.ts", status: "modified", added: 0, removed: 0 },
    ]);
  });

  it("read the PR: state, draft, conflicts, checks (none pass, pending waits, a failure fails) and change requests", () => {
    const view = (rollup: unknown[], extra: Record<string, unknown> = {}) =>
      JSON.stringify({ state: "OPEN", isDraft: true, headRefOid: "abc", mergeable: "MERGEABLE", statusCheckRollup: rollup, reviews: [], ...extra });
    expect(parsePrStatus(view([]))).toEqual({ state: "OPEN", isDraft: true, headSha: "abc", checks: "pass", failures: [], changesRequested: [], conflicting: false });
    expect(parsePrStatus(view([{ name: "ci", status: "IN_PROGRESS" }])).checks).toBe("pending");
    expect(parsePrStatus(view([{ name: "ci", status: "COMPLETED", conclusion: "FAILURE" }]))).toMatchObject({ checks: "fail", failures: ["ci"] });
    expect(parsePrStatus(view([{ context: "deploy", state: "ERROR" }]))).toMatchObject({ checks: "fail", failures: ["deploy"] });
    expect(parsePrStatus(view([], { mergeable: "CONFLICTING" })).conflicting).toBe(true);
    expect(parsePrStatus(view([], { mergeable: "UNKNOWN" })).checks).toBe("pending");
    expect(parsePrStatus(view([], { state: "MERGED", isDraft: false })).state).toBe("MERGED");
    const reviews = [
      { state: "APPROVED", body: "ok", submittedAt: "2026-11-13T10:00:00Z", author: { login: "a" } },
      { state: "CHANGES_REQUESTED", body: "Rename it", submittedAt: "2026-11-13T11:00:00Z", author: { login: "merge-agent" } },
    ];
    expect(parsePrStatus(view([], { reviews })).changesRequested).toEqual([{ at: "2026-11-13T11:00:00Z", by: "merge-agent", body: "Rename it" }]);
  });
});

/**
 * A real git repository with a bare remote, a project folder inside it, and fake gate commands:
 * the type checker prints whatever `type-errors.txt` in the folder it runs in says.
 */
describe("git and the gate, against a real repository", () => {
  let dir: string;
  let config: EffectsConfig;
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const task = { id: "0123456789abcdef", title: "Add the thing", ticketKey: "#5" } as Task;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "factory-effects-"));
    const remote = join(dir, "remote.git");
    const repo = join(dir, "repo");
    git(dir, "init", "--bare", "-b", "factory/main", remote);
    mkdirSync(join(repo, "app", "src"), { recursive: true });
    git(repo, "init", "-b", "factory/main");
    git(repo, "config", "user.email", "factory@example.com");
    git(repo, "config", "user.name", "Factory Test");
    writeFileSync(join(repo, "app", "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(repo, "app", "type-errors.txt"), "src/old.ts(1,1): error TS2322: Already broken on the base.\n");
    writeFileSync(join(repo, "README.md"), "outside the project\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "base");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-u", "origin", "factory/main");
    const printErrors = "const fs=require('fs');const t=fs.existsSync('type-errors.txt')?fs.readFileSync('type-errors.txt','utf8'):'';process.stdout.write(t);process.exit(t.trim()?2:0)";
    config = {
      repo,
      projectDir: "app",
      remote: "origin",
      base: "factory/main",
      home: join(dir, "home"),
      claudeCommand: ["false"],
      installCommand: ["true"],
      syncCommand: ["true"],
      lintCommand: ["true"],
      typecheckCommand: ["node", "-e", printErrors],
      testCommand: ["node", "-e", "process.exit(0)", "--"],
      env: { start: null, healthUrls: [], logLines: 10 },
    };
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("makes a worktree on a new branch from the base, outside the repository, and returns the project folder", async () => {
    const fx = createEffects(config);
    const { branch, worktree } = await fx.createWorktree(task);
    expect(branch).toMatch(/^factory\/issue-5-add-the-thing-012345$/);
    expect(worktree).toBe(join(config.home, "worktrees", task.id, "app"));
    expect(existsSync(join(worktree, "src", "a.ts"))).toBe(true);
    // Running it again (a retry) reuses the worktree.
    expect((await fx.createWorktree(task)).worktree).toBe(worktree);
  });

  it("diffs against the merge base, relative to the project, ignoring files outside it", async () => {
    const fx = createEffects(config);
    const { worktree } = await fx.createWorktree(task);
    writeFileSync(join(worktree, "src", "b.ts"), "export const b = 2;\nexport const c = 3;\n");
    writeFileSync(join(worktree, "src", "a.ts"), "export const a = 2;\n");
    writeFileSync(join(worktree, "..", "README.md"), "changed outside\n");
    const changes = await fx.diff(worktree);
    expect(changes.sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: "src/a.ts", status: "modified", added: 1, removed: 1 },
      { path: "src/b.ts", status: "added", added: 2, removed: 0 },
    ]);
  });

  it("lets one task at a time use the merge-base checkout", async () => {
    const fx = createEffects(config);
    const { worktree } = await fx.createWorktree(task);
    const log: string[] = [];
    const use = (name: string) =>
      fx.withBaseCheckout(worktree, async () => {
        log.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, 20));
        log.push(`end ${name}`);
      });
    await Promise.all([use("a"), use("b")]);
    expect(log).toEqual(["start a", "end a", "start b", "end b"]);
  });

  it("reinstalls the base checkout when the install command changes, not on every use", async () => {
    const count = join(config.home, "installs.txt");
    const installs = () => (existsSync(count) ? readFileSync(count, "utf8").split("\n").filter(Boolean) : []);
    const withInstall = (tag: string) => createEffects({ ...config, installCommand: ["sh", "-c", `echo ${tag} >> ${JSON.stringify(count)}`] });
    const { worktree } = await withInstall("a").createWorktree(task);
    const before = installs().length;
    await withInstall("a").withBaseCheckout(worktree, async (checkout) => checkout);
    await withInstall("a").withBaseCheckout(worktree, async (checkout) => checkout);
    expect(installs().length - before).toBe(1);
    await withInstall("b").withBaseCheckout(worktree, async (checkout) => checkout);
    expect(installs().slice(-1)).toEqual(["b"]);
  });

  it("passes the gate when the only type errors already exist on the merge base", async () => {
    const fx = createEffects(config);
    const { worktree } = await fx.createWorktree(task);
    const result = await fx.gate(worktree, await fx.diff(worktree));
    expect(result.steps.find((s) => s.name === "typecheck")).toMatchObject({ ok: true });
    expect(result.steps.filter((s) => !s.ok)).toEqual([]);
    expect(existsSync(join(config.home, "base", "app"))).toBe(true);
  });

  it("fails the gate with only the new type errors, matched without line numbers", async () => {
    const fx = createEffects(config);
    const { worktree } = await fx.createWorktree(task);
    writeFileSync(join(worktree, "type-errors.txt"), "src/old.ts(7,3): error TS2322: Already broken on the base.\nsrc/b.ts(2,1): error TS2304: Cannot find name 'x'.\n");
    const result = await fx.gate(worktree, await fx.diff(worktree));
    const types = result.steps.find((s) => s.name === "typecheck")!;
    expect(types.ok).toBe(false);
    expect(types.output).toBe("src/b.ts(2,1): error TS2304: Cannot find name 'x'.");
    writeFileSync(join(worktree, "type-errors.txt"), "src/old.ts(1,1): error TS2322: Already broken on the base.\n");
  });

  it("fails the gate when the change adds an escape hatch", async () => {
    const fx = createEffects(config);
    const { worktree } = await fx.createWorktree(task);
    writeFileSync(join(worktree, "src", "c.ts"), "export const c = (1 as any);\n");
    const result = await fx.gate(worktree, await fx.diff(worktree));
    expect(result.steps.find((s) => s.name === "escape hatches")).toMatchObject({ ok: false, output: "The change adds: 1 more `as any`." });
    rmSync(join(worktree, "src", "c.ts"));
  });

  it("moves the change onto a moved base as one patch, leaving conflict markers in conflicting files", async () => {
    const fx = createEffects(config);
    const other = { ...task, id: "fedcba9876543210", title: "Conflicting change" } as Task;
    const { worktree } = await fx.createWorktree(other);
    writeFileSync(join(worktree, "src", "a.ts"), "export const a = 'task';\n");
    writeFileSync(join(worktree, "src", "mine.ts"), "export const mine = 1;\n");
    expect(await fx.syncWithBase(worktree)).toEqual({ upToDate: true, conflicts: [] });
    // Someone merges a change to the same line on the base.
    writeFileSync(join(config.repo, "app", "src", "a.ts"), "export const a = 'base';\n");
    git(config.repo, "commit", "-am", "base moves");
    git(config.repo, "push", "origin", "factory/main");
    const result = await fx.syncWithBase(worktree);
    expect(result).toEqual({ upToDate: false, conflicts: ["src/a.ts"] });
    expect(readFileSync(join(worktree, "src", "a.ts"), "utf8")).toMatch(/<<<<<<<[\s\S]*'base'[\s\S]*'task'/);
    expect(readFileSync(join(worktree, "src", "mine.ts"), "utf8")).toBe("export const mine = 1;\n");
    expect(git(worktree, "rev-parse", "HEAD")).toBe(git(config.repo, "rev-parse", "origin/factory/main"));
  });

  it("commits only the project folder and pushes the branch", async () => {
    const fx = createEffects(config);
    const { branch, worktree } = await fx.createWorktree(task);
    await fx.commitAndPush(worktree, branch, "Add b\n\nby the factory");
    const remoteFiles = git(config.repo, "ls-tree", "-r", "--name-only", `refs/remotes/origin/${branch}`).split("\n");
    git(config.repo, "fetch", "origin");
    const pushed = git(config.repo, "ls-tree", "-r", "--name-only", `origin/${branch}`).split("\n");
    expect(pushed).toContain("app/src/b.ts");
    expect(git(config.repo, "show", `origin/${branch}:README.md`)).toBe("outside the project");
    expect(remoteFiles.length).toBeGreaterThan(0);
    // Nothing left to commit: pushing again is a no-op, not an error.
    await fx.commitAndPush(worktree, branch, "again");
  });
});
