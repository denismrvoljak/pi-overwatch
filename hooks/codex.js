// Codex adapter. Wire it up with `agentwatch install-codex-hooks`.
//
// Codex hooks mirror Claude Code's names and payloads, and add a dedicated
// PermissionRequest event, so blocked state needs no message sniffing.

import os from "node:os";
import path from "node:path";

import { readTailLines, runAgentHook } from "./agent-hook.js";

export const CODEX = { source: "codex", label: "codex", configKey: "codex", processNames: ["codex"], readTitle: readCodexTitle };

// Codex lists named threads in session_index.jsonl; the last line for an id wins.
export function readCodexTitle(payload) {
  if (!payload.session_id) return undefined;
  const index = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "session_index.jsonl");
  for (const line of readTailLines(index).reverse()) {
    if (!line.includes(payload.session_id)) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.id === payload.session_id && entry.thread_name) return { name: entry.thread_name, kind: "custom" };
    } catch {
      // skip a partial line
    }
  }
  return undefined;
}

export const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
  "Interrupt",
  "SessionEnd",
];

export function runCodexHook(argv = []) {
  runAgentHook(CODEX, argv);
}
