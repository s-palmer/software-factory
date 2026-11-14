/** Entry point: `bin/factory <command>` (or `pnpm factory <command>`). */
import { initProject } from "./init";
import { runCli } from "./factory";

const argv = process.argv.slice(2);
if (argv[0] === "init") {
  // Local: sets up the repository in the current folder; needs no running factory.
  process.exitCode = initProject(process.cwd(), { force: argv.includes("--force"), json: argv.includes("--json") });
} else {
  process.exitCode = await runCli(argv, {
    fetch: (url, init) => fetch(url, init),
    env: process.env,
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
  });
}
