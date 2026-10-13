// Codex adapter. Wire it up with `pi-overwatch install-codex-hooks`.
//
// Codex hooks mirror Claude Code's names and payloads, and add a dedicated
// PermissionRequest event, so blocked state needs no message sniffing.

import { runAgentHook } from "./agent-hook.js";

export const CODEX = { source: "codex", label: "codex", configKey: "codex" };

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
