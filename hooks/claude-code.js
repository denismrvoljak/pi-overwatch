// Claude Code adapter. Wire it up with `pi-overwatch install-claude-hooks`.

import { runAgentHook } from "./agent-hook.js";

export const CLAUDE_CODE = { source: "claude-code", label: "claude", configKey: "claudeCode" };

export const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "Stop",
  "SessionEnd",
];

export function runClaudeHook(argv = []) {
  runAgentHook(CLAUDE_CODE, argv);
}
