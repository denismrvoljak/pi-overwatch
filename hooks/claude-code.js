// Claude Code producer for Overwatch.
//
// Pi writes agent state from a long-lived extension; Claude Code has no such
// process, so state is driven by hooks instead. Each hook is its own process,
// which means every handler is load-modify-save rather than mutating in memory.
// Wire it up with `pi-overwatch install-claude-hooks`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

import { emitProgramStatus } from "./program-status.js";
import { spawnTmuxEffects } from "./tmux-effects.js";

const MAX_EVENTS_FILE_BYTES = 5 * 1024 * 1024;
const TRIM_EVENTS_TO_LAST_LINES = 2_000;

// No heartbeat process exists, so a long tool call would otherwise read as
// stale. The dashboard honours this per-agent value instead of its own default.
const DEFAULT_STALE_MS = 180_000;

function getRootDir() {
  return process.env.PI_OVERWATCH_DIR || path.join(os.homedir(), ".pi", "overwatch");
}

function nowIso() {
  return new Date().toISOString();
}

function safeMkdir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWriteText(filePath, text) {
  safeMkdir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, text, "utf8");
  fs.renameSync(tempPath, filePath);
}

function atomicWriteJson(filePath, data) {
  atomicWriteText(filePath, JSON.stringify(data, null, 2) + "\n");
}

function trimJsonlFile(filePath, maxBytes, keepLastLines) {
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    return;
  }
  if (stats.size <= maxBytes) return;

  const text = fs.readFileSync(filePath, "utf8").trim();
  if (!text) {
    atomicWriteText(filePath, "");
    return;
  }
  const trimmed = text.split("\n").slice(-keepLastLines).join("\n");
  atomicWriteText(filePath, trimmed ? trimmed + "\n" : "");
}

function appendJsonl(filePath, data) {
  safeMkdir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(data) + "\n", "utf8");
  trimJsonlFile(filePath, MAX_EVENTS_FILE_BYTES, TRIM_EVENTS_TO_LAST_LINES);
}

function sanitizeSummary(value, max = 120) {
  if (typeof value !== "string") return undefined;
  const compact = value.replace(/\s+/g, " ").trim();
  return compact ? compact.slice(0, max) : undefined;
}

function firstLine(value) {
  if (!value) return undefined;
  return sanitizeSummary(value.split("\n").find((line) => line.trim().length > 0));
}

function shortenPath(filePath) {
  if (!filePath) return undefined;
  const normalized = String(filePath).replace(`${os.homedir()}/`, "~/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 3) return normalized;
  return `…/${parts.slice(-3).join("/")}`;
}

function tmuxRun(args) {
  try {
    return execFileSync("tmux", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // The hook blocks Claude Code; a slow tmux must not.
      timeout: 500,
    }).trim();
  } catch {
    return undefined;
  }
}

function getTmuxInfo() {
  if (!process.env.TMUX) return undefined;

  const targetArgs = process.env.TMUX_PANE ? ["-t", process.env.TMUX_PANE] : [];
  const format = "#{session_name}\t#{window_index}\t#{window_name}\t#{pane_index}\t#{pane_id}\t#{pane_current_path}";
  const output = tmuxRun(["display-message", "-p", ...targetArgs, format]);
  if (!output) return undefined;

  const [sessionName, windowIndex, windowName, paneIndex, paneId, panePath] = output.split("\t");
  if (!sessionName) return undefined;

  return {
    sessionName,
    windowIndex: windowIndex || undefined,
    windowName: windowName || undefined,
    paneIndex: paneIndex || undefined,
    paneId: paneId || process.env.TMUX_PANE || undefined,
    panePath: panePath || undefined,
  };
}

function readConfig(rootDir) {
  const defaults = { notify: true, bell: false, staleMs: DEFAULT_STALE_MS, programStatus: false };
  try {
    const userConfig = JSON.parse(fs.readFileSync(path.join(rootDir, "config.json"), "utf8"));
    return {
      ...defaults,
      programStatus: userConfig?.programStatus?.emit === true,
      ...(userConfig?.tmux || {}),
      ...(userConfig?.claudeCode || {}),
    };
  } catch {
    return defaults;
  }
}

function summarizeToolStart(toolName, input) {
  const args = input || {};
  switch (toolName) {
    case "Read":
      return `Reading ${shortenPath(args.file_path) ?? "file"}`;
    case "Write":
      return `Writing ${shortenPath(args.file_path) ?? "file"}`;
    case "Edit":
    case "NotebookEdit":
      return `Editing ${shortenPath(args.file_path ?? args.notebook_path) ?? "file"}`;
    case "Bash": {
      const command = firstLine(typeof args.command === "string" ? args.command : undefined);
      return command ? `Running ${command}` : "Running command";
    }
    case "Grep":
      return args.pattern ? `Grepping ${sanitizeSummary(String(args.pattern), 60)}` : "Grepping";
    case "Glob":
      return args.pattern ? `Globbing ${sanitizeSummary(String(args.pattern), 60)}` : "Globbing";
    case "WebSearch":
      return args.query ? `Searching ${sanitizeSummary(String(args.query), 60)}` : "Searching web";
    case "WebFetch":
      return args.url ? `Fetching ${sanitizeSummary(String(args.url), 60)}` : "Fetching content";
    case "Task":
      return args.description ? `Agent: ${sanitizeSummary(String(args.description), 60)}` : "Running subagent";
    case "TodoWrite":
      return "Updating todos";
    default:
      // MCP tools arrive as mcp__server__tool.
      return toolName.replace(/^mcp__/, "").replace(/__/g, " · ").replace(/_/g, " ");
  }
}

// "Claude needs your permission to use Bash" vs "Claude is waiting for your
// input" — same hook, opposite meanings.
function classifyNotification(message) {
  if (/permission|approv|confirm|allow/i.test(message)) return "permission";
  if (/waiting for your input|idle/i.test(message)) return "idle";
  return "unknown";
}

function getIdentityLabel(state) {
  return state.tmux?.sessionName || state.sessionName || state.projectName || path.basename(state.cwd || state.agentId);
}

function agentIdFor(payload) {
  // Hooks are separate processes, so the id must come from session identity,
  // never from pid. Pi keys on pid; that would produce a new row per hook.
  const seed = `${os.hostname()}:claude-code:${payload.session_id || payload.cwd || "unknown"}`;
  return crypto.createHash("sha1").update(seed).digest("hex").slice(0, 12);
}

// Pane identity rarely changes mid-session, so only SessionStart and
// UserPromptSubmit pay for a tmux round trip; tool hooks reuse the cache.
const TMUX_LOOKUP_EVENTS = new Set(["SessionStart", "UserPromptSubmit"]);

function resolveTmux(existing, event) {
  const cached = existing?.tmux;
  if (cached && cached.paneId === process.env.TMUX_PANE && !TMUX_LOOKUP_EVENTS.has(event)) return cached;
  return getTmuxInfo() || cached;
}

function loadOrInit(rootDir, payload, event) {
  const agentId = agentIdFor(payload);
  const filePath = path.join(rootDir, "agents", `${agentId}.json`);
  const timestamp = nowIso();

  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    existing = undefined;
  }

  const cwd = payload.cwd || existing?.cwd || process.cwd();
  const tmux = resolveTmux(existing, event);

  // Before statuses followed OSC 7501, blocked was a flag on `working`.
  if (existing?.blocked) {
    existing.status = "blocked";
    existing.kind = "permission";
  }
  if (existing) delete existing.blocked;

  const state = existing || {
    agentId,
    status: "idle",
    phase: "waiting",
    queue: { steering: 0, followUp: 0 },
    startedAt: undefined,
    finishedAt: undefined,
  };

  return {
    filePath,
    state: {
      ...state,
      agentId,
      source: "claude-code",
      pid: process.ppid,
      hostname: os.hostname(),
      projectName: path.basename(cwd),
      cwd,
      sessionFile: payload.transcript_path || state.sessionFile,
      sessionName: payload.session_id ? String(payload.session_id).slice(0, 8) : state.sessionName,
      tmux,
      updatedAt: timestamp,
      lastHeartbeatAt: timestamp,
      queue: state.queue || { steering: 0, followUp: 0 },
    },
  };
}

function emitEvent(rootDir, state, type, details = {}) {
  appendJsonl(path.join(rootDir, "events.jsonl"), {
    ts: nowIso(),
    type,
    source: "claude-code",
    agentId: state.agentId,
    pid: state.pid,
    hostname: state.hostname,
    projectName: state.projectName,
    cwd: state.cwd,
    sessionFile: state.sessionFile,
    tmuxSessionName: state.tmux?.sessionName,
    tmuxPaneId: state.tmux?.paneId,
    ...details,
  });
}

function notifyFinished(state, config) {
  if (!state.tmux) return;
  if (!config.notify) {
    spawnTmuxEffects({ refresh: true });
    return;
  }

  const runtimeMs =
    state.startedAt && state.finishedAt
      ? new Date(state.finishedAt).getTime() - new Date(state.startedAt).getTime()
      : undefined;
  const runtime =
    runtimeMs !== undefined && runtimeMs >= 0
      ? ` (${Math.floor(runtimeMs / 60000)}m${Math.floor((runtimeMs % 60000) / 1000)}s)`
      : "";
  const icon = state.status === "error" ? "✕" : "✓";
  const message = `claude ${icon} ${getIdentityLabel(state)}: ${state.status}${runtime}`.replace(/#/g, "##");
  spawnTmuxEffects({ refresh: true, message, paneId: state.tmux.paneId, bell: config.bell });
}

function notifyBlocked(state, config, detail) {
  if (!state.tmux) return;
  const message = config.notify ? `claude ⏸ ${getIdentityLabel(state)}: ${detail}`.replace(/#/g, "##") : undefined;
  spawnTmuxEffects({ refresh: true, message, paneId: state.tmux.paneId });
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export function runClaudeHook(argv = []) {
  const raw = readStdin();
  let payload;
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    payload = {};
  }

  const event = argv[0] || payload.hook_event_name;
  if (!event) return;

  const rootDir = getRootDir();
  const config = readConfig(rootDir);
  const { filePath, state } = loadOrInit(rootDir, payload, event);
  state.staleMs = config.staleMs;

  // Report to the terminal first, so a freshly resolved tty is cached too.
  const save = () => {
    emitProgramStatus(state, { app: "claude-code", enabled: config.programStatus, refreshTty: TMUX_LOOKUP_EVENTS.has(event) });
    atomicWriteJson(filePath, state);
  };

  switch (event) {
    case "SessionStart":
      // Also fires on resume/clear/compact, so don't clobber an active run.
      if (state.status !== "working" && state.status !== "blocked") {
        state.status = "idle";
        state.phase = "waiting";
        state.toolName = undefined;
        state.kind = undefined;
      }
      emitEvent(rootDir, state, "session_start", {
        reason: payload.source,
        identity: getIdentityLabel(state),
        tmux: state.tmux,
      });
      break;

    case "UserPromptSubmit":
      state.status = "working";
      state.phase = "thinking";
      state.toolName = undefined;
      state.kind = undefined;
      state.summary = sanitizeSummary(payload.prompt) ?? "Working";
      state.startedAt = nowIso();
      state.finishedAt = undefined;
      emitEvent(rootDir, state, "agent_start", { summary: state.summary });
      save();
      if (state.tmux) spawnTmuxEffects({ refresh: true });
      return;

    case "PreToolUse":
      state.status = "working";
      state.phase = "tool";
      state.kind = undefined;
      state.toolName = payload.tool_name;
      state.summary = summarizeToolStart(payload.tool_name, payload.tool_input);
      if (!state.startedAt) state.startedAt = nowIso();
      state.finishedAt = undefined;
      emitEvent(rootDir, state, "tool_start", {
        toolName: payload.tool_name,
        summary: state.summary,
      });
      break;

    case "PostToolUse": {
      state.kind = undefined;
      const failed = payload.tool_response?.success === false || Boolean(payload.tool_response?.error);
      if (failed) {
        state.status = "error";
        state.phase = "waiting";
        state.finishedAt = nowIso();
        state.summary = sanitizeSummary(payload.tool_response?.error) ?? `Tool failed: ${payload.tool_name}`;
      } else {
        state.status = "working";
        state.phase = "thinking";
      }
      state.toolName = undefined;
      emitEvent(rootDir, state, "tool_end", {
        toolName: payload.tool_name,
        isError: failed,
      });
      break;
    }

    case "Notification": {
      // This hook fires for two unrelated things: a permission prompt (Claude
      // is blocked and needs you) and a plain idle timeout ~60s after it has
      // already stopped. Only the first is worth flagging — treating the idle
      // one as activity would resurrect a finished session into `working`.
      const message = sanitizeSummary(payload.message) || "Waiting for input";
      state.toolName = undefined;

      if (classifyNotification(message) === "permission") {
        state.status = "blocked";
        state.kind = "permission";
        state.phase = "waiting";
        state.summary = message;
        emitEvent(rootDir, state, "notification", { blocked: true, summary: state.summary });
        notifyBlocked(state, config, message);
      } else if (classifyNotification(message) === "idle") {
        // Preserve a finished status; only a run that never saw Stop gets
        // demoted out of `working`.
        if (state.status === "working" || state.status === "blocked") state.status = "idle";
        state.phase = "waiting";
        state.kind = undefined;
        emitEvent(rootDir, state, "notification", { blocked: false, idle: true });
      } else {
        // Unrecognised message: record it, but never change status. Guessing
        // wrong here is what produced phantom stale rows in the first place.
        state.summary = sanitizeSummary(message) ?? state.summary;
        emitEvent(rootDir, state, "notification", { summary: state.summary });
      }
      break;
    }

    case "Stop":
      state.status = state.status === "error" ? "error" : "done";
      state.phase = "waiting";
      state.toolName = undefined;
      state.finishedAt = nowIso();
      // A pending permission prompt is no longer true once we stop.
      if (state.kind) state.summary = "Idle";
      state.kind = undefined;
      emitEvent(rootDir, state, "agent_end", { status: state.status });
      save();
      notifyFinished(state, config);
      return;

    case "SessionEnd":
      state.status = "offline";
      state.phase = "waiting";
      state.toolName = undefined;
      state.kind = undefined;
      state.finishedAt = state.finishedAt ?? nowIso();
      emitEvent(rootDir, state, "session_shutdown", { reason: payload.reason });
      save();
      if (state.tmux) spawnTmuxEffects({ refresh: true });
      return;

    default:
      return;
  }

  save();
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
