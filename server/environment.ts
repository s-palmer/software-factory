/**
 * The local environment: the copy of the app that the browser check runs against. One holder at a time (the
 * "env" lease): a task's browser check, or a person who started it from the dashboard or the CLI. This module
 * reports who holds it and lets a person start and stop their own copy. It never stops a task's copy, and never
 * stops an app the factory did not start.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EnvStatus } from "../shared/api";
import type { FactoryDb } from "./db";
import type { EnvController } from "./orchestrator";

export const ENV_LEASE = "env";

export interface LocalEnvConfig {
  /** The start command as written in the config, or null when none is set. */
  command: string | null;
  url: string;
  healthUrls: string[];
  /** Where a person's copy starts from: the repository checkout (its project folder). */
  checkout: string;
  artifactRoot: string;
}

export class LocalEnv {
  constructor(
    private readonly db: FactoryDb,
    private readonly env: EnvController,
    private readonly config: LocalEnvConfig,
  ) {}

  async status(): Promise<EnvStatus> {
    const [lease, up, tasks] = await Promise.all([this.db.getLease(ENV_LEASE), this.env.isUp(), this.db.listTasks()]);
    const holder = lease?.taskId ? await this.db.getTask(lease.taskId) : null;
    const waiting = [];
    for (const t of tasks.filter((x) => x.status === "browser_check" && x.id !== lease?.taskId)) {
      const full = await this.db.getTask(t.id);
      if (full?.context.envWait) waiting.push({ taskId: t.id, ticketKey: t.ticketKey, title: t.title, reason: full.context.envWait });
    }
    const external = up && !lease;
    return {
      configured: this.config.command !== null,
      command: this.config.command,
      url: this.config.url,
      healthUrls: this.config.healthUrls,
      up,
      lease: lease
        ? {
            holder: lease.taskId ? "task" : "person",
            taskId: lease.taskId,
            ticketKey: holder?.ticketKey ?? null,
            title: holder?.title ?? null,
            status: holder?.status ?? null,
            pid: lease.pid,
            running: lease.pid !== null && this.env.isRunning(lease.pid),
            acquiredAt: lease.acquiredAt,
            logPath: lease.logPath,
          }
        : null,
      external,
      portHolders: external && this.env.portHolders ? await this.env.portHolders() : [],
      waiting,
      log: lease?.logPath ? this.env.logTail(lease.logPath) : "",
    };
  }

  /** A person starts the app from the checkout. Refused while anyone holds it or an outside copy runs. */
  async start(): Promise<{ ok: boolean; message: string }> {
    if (!this.config.command) return { ok: false, message: "No start command is set (app.start in factory.config.json)." };
    if (await this.env.isUp()) return { ok: false, message: "The app already answers on its health URLs. Something outside the factory runs it." };
    if (!(await this.db.acquireLease(ENV_LEASE, null, null))) return { ok: false, message: "The local environment is in use." };
    const dir = join(this.config.artifactRoot, "env");
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, `manual-${Date.now()}.log`);
    try {
      const pid = this.env.start(this.config.checkout, logPath);
      await this.db.updateLeasePid(ENV_LEASE, pid, logPath);
      return { ok: true, message: `Started ${this.config.command} (pid ${pid}) from ${this.config.checkout}.` };
    } catch (error) {
      await this.db.releaseLease(ENV_LEASE);
      return { ok: false, message: (error as Error).message };
    }
  }

  /** A person stops the copy they started. A task's copy stops when its browser check ends. */
  async stop(): Promise<{ ok: boolean; message: string }> {
    const lease = await this.db.getLease(ENV_LEASE);
    if (!lease) return { ok: false, message: "Nothing to stop: the factory holds no local environment." };
    if (lease.taskId) return { ok: false, message: `Task ${lease.taskId} holds the local environment. It stops when its browser check ends.` };
    if (lease.pid) await this.env.stop(lease.pid);
    await this.db.releaseLease(ENV_LEASE);
    return { ok: true, message: "Stopped." };
  }
}
