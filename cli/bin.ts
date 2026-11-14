/** Entry point: `bin/factory <command>` (or `pnpm factory <command>`). */
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { TRACKER_PRESETS } from "../shared/config";
import { initProject, nodeIo, type TrackerChoice } from "./init";
import { runCli } from "./factory";

const argv = process.argv.slice(2);
if (argv[0] === "init") {
  // Local: sets up a repository; needs no running factory.
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      force: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      repo: { type: "string" },
      tracker: { type: "string" },
      base: { type: "string" },
      start: { type: "string" },
      url: { type: "string" },
      verify: { type: "boolean" },
      "no-verify": { type: "boolean" },
    },
  });
  if (values.tracker && !(values.tracker in TRACKER_PRESETS)) {
    process.stderr.write(`factory: --tracker must be one of ${Object.keys(TRACKER_PRESETS).join(", ")}\n`);
    process.exit(2);
  }
  const interactive = Boolean(process.stdin.isTTY) && !values.yes && !values.json;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = async (question: string, fallback: string) => (await rl!.question(`${question} [${fallback}]: `)) || fallback;
  try {
    process.exitCode = await initProject(
      process.cwd(),
      { force: values.force, json: values.json, interactive, repo: values.repo, tracker: values.tracker as TrackerChoice | undefined, base: values.base, start: values.start, url: values.url, verify: values["no-verify"] ? false : values.verify },
      nodeIo(ask),
    );
  } finally {
    rl?.close();
  }
} else {
  process.exitCode = await runCli(argv, {
    fetch: (url, init) => fetch(url, init),
    env: process.env,
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
  });
}
