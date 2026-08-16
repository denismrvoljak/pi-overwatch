// Registers the Overwatch producer in Claude Code's settings.json.
// Idempotent: re-running replaces Overwatch entries and leaves every other
// hook you have configured untouched.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CLAUDE_HOOK_EVENTS } from "./claude-code.js";

const HOOK_COMMAND = "pi-overwatch claude-hook";
// Marks our entries so re-install can find and replace them.
const MATCHER_EVENTS = new Set(["PreToolUse", "PostToolUse"]);

function settingsPath(scope) {
  return scope === "project"
    ? path.join(process.cwd(), ".claude", "settings.json")
    : path.join(os.homedir(), ".claude", "settings.json");
}

function isOverwatchEntry(entry) {
  return (entry?.hooks || []).some((hook) => String(hook?.command || "").includes("pi-overwatch"));
}

function buildEntry(event) {
  const entry = {
    hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 5 }],
  };
  if (MATCHER_EVENTS.has(event)) entry.matcher = "*";
  return entry;
}

export function installClaudeHooks(args = []) {
  const scope = args.includes("--project") ? "project" : "user";
  const dryRun = args.includes("--dry-run");
  const remove = args.includes("--uninstall");
  const filePath = settingsPath(scope);

  let settings = {};
  if (fs.existsSync(filePath)) {
    try {
      settings = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      process.stderr.write(`Refusing to touch unparseable ${filePath}: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
  }

  settings.hooks = settings.hooks || {};

  for (const event of CLAUDE_HOOK_EVENTS) {
    const existing = (settings.hooks[event] || []).filter((entry) => !isOverwatchEntry(entry));
    if (remove) {
      if (existing.length > 0) settings.hooks[event] = existing;
      else delete settings.hooks[event];
    } else {
      settings.hooks[event] = [...existing, buildEntry(event)];
    }
  }

  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  const output = JSON.stringify(settings, null, 2) + "\n";

  if (dryRun) {
    process.stdout.write(output);
    return;
  }

  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, `${filePath}.overwatch-backup`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, output, "utf8");

  const verb = remove ? "Removed" : "Installed";
  process.stdout.write(`${verb} Overwatch hooks in ${filePath}\n`);
  process.stdout.write(`Events: ${CLAUDE_HOOK_EVENTS.join(", ")}\n`);
  if (!remove) process.stdout.write("Restart Claude Code (or /hooks) to pick them up.\n");
}
