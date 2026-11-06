// Claude Code adapter. Wire it up with `agentwatch install-claude-hooks`.

import { readTailLines, runAgentHook } from "./agent-hook.js";

export const CLAUDE_CODE = { source: "claude-code", label: "claude", configKey: "claudeCode", processNames: ["claude"], readTitle: readClaudeTitle };

// The transcript re-appends its title every few turns: `custom-title` when the
// user or app named the session, `ai-title` when Claude Code generated one.
export function readClaudeTitle(payload) {
  if (!payload.transcript_path) return undefined;
  let ai;
  for (const line of readTailLines(payload.transcript_path).reverse()) {
    if (!line.includes("-title\"")) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "custom-title" && entry.customTitle) return { name: entry.customTitle, kind: "custom" };
    if (entry.type === "ai-title" && entry.aiTitle && !ai) ai = { name: entry.aiTitle, kind: "ai" };
  }
  return ai;
}

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
