#!/usr/bin/env node
// PreToolUse hook for the implement phase. Usage: node guard.mjs <locked-list.json>
// Reads the hook event on stdin. If the tool would write a locked file, exit 2 with a message, which makes
// Claude Code refuse the call and show the message to the model.
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    // The file may not exist yet; resolve its folder instead.
    try {
      return resolve(realpathSync(dirname(path)), path.split(/[\\/]/).pop());
    } catch {
      return path;
    }
  }
};

const event = JSON.parse(readFileSync(0, "utf8") || "{}");
const cwd = event.cwd || process.cwd();
const target = event.tool_input?.file_path ?? event.tool_input?.notebook_path;
if (!target) process.exit(0);

const locked = JSON.parse(readFileSync(process.argv[2], "utf8"));
const path = real(isAbsolute(target) ? target : resolve(cwd, target));
const hit = locked.find((file) => real(resolve(cwd, file)) === path);
if (hit) {
  process.stderr.write(`${hit} is locked: the test phase wrote it and the factory checked it fails. Change the code under test, not the test. If the test itself is wrong, describe the problem in testFixes.\n`);
  process.exit(2);
}
process.exit(0);
