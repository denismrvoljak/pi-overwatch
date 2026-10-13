// Registers the Overwatch producer in Claude Code's settings.json or Codex's
// hooks.json. Both use the same { hooks: { Event: [entry] } } shape.
// Idempotent: re-running replaces Overwatch entries and leaves every other
// hook you have configured untouched.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CLAUDE_HOOK_EVENTS } from "./claude-code.js";
import { CODEX_HOOK_EVENTS } from "./codex.js";

// Tool events take a matcher; "*" matches every tool in both harnesses.
const MATCHER_EVENTS = new Set(["PreToolUse", "PermissionRequest", "PostToolUse"]);

const TARGETS = {
  claude: {
    name: "Claude Code",
    command: "pi-overwatch claude-hook",
    events: CLAUDE_HOOK_EVENTS,
    dir: ".claude",
    file: "settings.json",
    restartHint: "Restart Claude Code (or /hooks) to pick them up.",
  },
  codex: {
    name: "Codex",
    command: "pi-overwatch codex-hook",
    events: CODEX_HOOK_EVENTS,
    dir: ".codex",
    file: "hooks.json",
    // Codex caps these while it shuts down or interrupts; keep its default.
    defaultTimeoutEvents: new Set(["SessionEnd", "Interrupt"]),
    restartHint: "Restart Codex, then approve the new hooks in /hooks (Codex asks before running unreviewed hooks).",
  },
};

function settingsPath(target, scope) {
  const base = scope === "project" ? process.cwd() : os.homedir();
  return path.join(base, target.dir, target.file);
}

function isOverwatchEntry(entry) {
  return (entry?.hooks || []).some((hook) => String(hook?.command || "").includes("pi-overwatch"));
}

function buildEntry(target, event) {
  const hook = { type: "command", command: target.command };
  if (!target.defaultTimeoutEvents?.has(event)) hook.timeout = 10;
  const entry = { hooks: [hook] };
  if (MATCHER_EVENTS.has(event)) entry.matcher = "*";
  return entry;
}

function installHooks(target, args) {
  const scope = args.includes("--project") ? "project" : "user";
  const dryRun = args.includes("--dry-run");
  const remove = args.includes("--uninstall");
  const filePath = settingsPath(target, scope);

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

  for (const event of target.events) {
    const existing = (settings.hooks[event] || []).filter((entry) => !isOverwatchEntry(entry));
    if (remove) {
      if (existing.length > 0) settings.hooks[event] = existing;
      else delete settings.hooks[event];
    } else {
      settings.hooks[event] = [...existing, buildEntry(target, event)];
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
  process.stdout.write(`${verb} Overwatch ${target.name} hooks in ${filePath}\n`);
  process.stdout.write(`Events: ${target.events.join(", ")}\n`);
  if (!remove) process.stdout.write(`${target.restartHint}\n`);
}

export function installClaudeHooks(args = []) {
  installHooks(TARGETS.claude, args);
}

export function installCodexHooks(args = []) {
  installHooks(TARGETS.codex, args);
}
