#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

const rootDir = process.env.PI_OVERWATCH_DIR || path.join(os.homedir(), ".pi", "overwatch");
const agentsDir = path.join(rootDir, "agents");
const eventsFile = path.join(rootDir, "events.jsonl");
const configFile = path.join(rootDir, "config.json");
const refreshMs = Number(process.env.PI_OVERWATCH_REFRESH_MS || 1000);
const staleAfterMs = Number(process.env.PI_OVERWATCH_STALE_MS || 30000);

let showOffline = false;
let workingOnly = false;
let rows = [];
let intervalHandle;
let watchHandle;
let needsRender = true;

function ensureDir() {
  fs.mkdirSync(agentsDir, { recursive: true });
}

function readConfig() {
  const defaults = {
    dashboard: {
      identity: "auto",
      showColumnHeader: true,
    },
  };

  try {
    if (!fs.existsSync(configFile)) return defaults;
    const userConfig = JSON.parse(fs.readFileSync(configFile, "utf8"));
    return {
      dashboard: {
        ...defaults.dashboard,
        ...(userConfig?.dashboard || {}),
      },
    };
  } catch {
    return defaults;
  }
}

function clearScreen() {
  process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l");
}

function restoreScreen() {
  process.stdout.write("\x1b[?25h\x1b[?1049l");
}

function color(code, text) {
  return `\x1b[${code}m${text}\x1b[0m`;
}

function dim(text) {
  return color("2", text);
}

function bold(text) {
  return color("1", text);
}

function green(text) {
  return color("32", text);
}

function yellow(text) {
  return color("33", text);
}

function red(text) {
  return color("31", text);
}

function cyan(text) {
  return color("36", text);
}

function visible(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function truncate(text, width) {
  const plain = visible(text);
  if (width <= 0) return "";
  if (plain.length <= width) return text;
  return plain.slice(0, Math.max(0, width - 1)) + "…";
}

function pad(text, width) {
  const plain = visible(text);
  if (plain.length >= width) return truncate(text, width);
  return text + " ".repeat(width - plain.length);
}

function getCwdLabel(agent) {
  return path.basename(agent.cwd || agent.projectName || agent.agentId);
}

function getIdentityLabel(agent, identityMode) {
  const tmuxName = agent.tmux?.sessionName;
  const cwdName = getCwdLabel(agent);
  const sessionName = agent.sessionName;

  switch (identityMode) {
    case "tmux":
      return tmuxName || sessionName || cwdName;
    case "cwd":
      return cwdName;
    case "both":
      if (tmuxName && tmuxName !== cwdName) return `${tmuxName} · ${cwdName}`;
      return tmuxName || sessionName || cwdName;
    case "auto":
    default:
      return tmuxName || sessionName || cwdName;
  }
}

function getIdentityMeta(agent) {
  if (agent.tmux?.sessionName) {
    const pane = [agent.tmux.windowIndex, agent.tmux.paneIndex].filter(Boolean).join(".");
    return pane ? `tmux ${pane}` : "tmux";
  }
  if (agent.sessionName) return "pi session";
  return agent.cwd || "cwd";
}

function readAgents() {
  ensureDir();
  const files = fs.readdirSync(agentsDir).filter((file) => file.endsWith(".json"));
  const now = Date.now();

  return files
    .map((file) => {
      try {
        const fullPath = path.join(agentsDir, file);
        const state = JSON.parse(fs.readFileSync(fullPath, "utf8"));
        const heartbeatAgeMs = state.lastHeartbeatAt ? now - new Date(state.lastHeartbeatAt).getTime() : Infinity;
        const computedStatus = state.status === "working" && heartbeatAgeMs > staleAfterMs ? "stale" : state.status;
        return {
          ...state,
          file: fullPath,
          computedStatus,
          heartbeatAgeMs,
        };
      } catch (error) {
        return {
          agentId: file.replace(/\.json$/, ""),
          projectName: file,
          sessionName: undefined,
          tmux: undefined,
          cwd: "",
          status: "error",
          computedStatus: "error",
          phase: "waiting",
          summary: String(error),
          updatedAt: new Date(0).toISOString(),
          heartbeatAgeMs: Infinity,
        };
      }
    })
    .filter((agent) => (showOffline ? true : agent.computedStatus !== "offline"))
    .filter((agent) => (workingOnly ? agent.computedStatus === "working" || agent.computedStatus === "stale" : true))
    .sort((a, b) => {
      const order = { working: 0, stale: 1, done: 2, idle: 3, error: 4, offline: 5 };
      const left = order[a.computedStatus] ?? 99;
      const right = order[b.computedStatus] ?? 99;
      if (left !== right) return left - right;
      return (b.updatedAt || "").localeCompare(a.updatedAt || "");
    });
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "--:--";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatAge(ms) {
  if (!Number.isFinite(ms)) return "--";
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${sec}s`;
}

function iconFor(status) {
  switch (status) {
    case "working":
      return cyan("●");
    case "done":
      return green("✓");
    case "stale":
      return yellow("!");
    case "error":
      return red("✕");
    case "offline":
      return dim("○");
    default:
      return dim("·");
  }
}

function groupRows(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.computedStatus;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function readEventTail(limit = 8) {
  try {
    const text = fs.readFileSync(eventsFile, "utf8").trim();
    if (!text) return [];
    return text.split("\n").slice(-limit).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { ts: "", type: "parse_error", projectName: "", summary: line };
      }
    });
  } catch {
    return [];
  }
}

function render() {
  if (!needsRender) return;
  needsRender = false;
  rows = readAgents();

  const config = readConfig();
  const identityMode = config.dashboard.identity;
  const width = process.stdout.columns || 120;
  const height = process.stdout.rows || 40;
  const now = Date.now();
  const header = [
    bold("OVERWATCH") + dim(`  ${rootDir}`),
    dim(`q quit  f working-only  a show-offline  r refresh  identity=${identityMode}`),
    "",
  ];

  const body = [];
  const groups = groupRows(rows);
  const orderedGroups = ["working", "stale", "done", "idle", "error", "offline"];
  for (const group of orderedGroups) {
    const items = groups.get(group);
    if (!items || items.length === 0) continue;
    body.push(bold(group.toUpperCase()));
    if (config.dashboard.showColumnHeader) {
      const headerCols = [
        pad(dim("S"), 2),
        pad(dim("TARGET"), 22),
        pad(dim("WHERE"), 10),
        pad(dim("DOING"), 12),
        pad(dim("SUMMARY"), Math.max(10, width - 73)),
        pad(dim("Q"), 5),
        pad(dim("LAST"), 6),
        pad(dim("RUN"), 8),
      ];
      body.push(truncate(headerCols.join(" "), width));
    }
    for (const item of items) {
      const startedAt = item.startedAt ? new Date(item.startedAt).getTime() : now;
      const elapsed = item.computedStatus === "working" || item.computedStatus === "stale"
        ? formatDuration(now - startedAt)
        : item.finishedAt && item.startedAt
          ? formatDuration(new Date(item.finishedAt).getTime() - new Date(item.startedAt).getTime())
          : "--:--";
      const queue = `${item.queue?.steering ?? 0}/${item.queue?.followUp ?? 0}`;
      const identity = getIdentityLabel(item, identityMode);
      const identityMeta = getIdentityMeta(item);
      const cols = [
        pad(iconFor(item.computedStatus), 2),
        pad(identity, 22),
        pad(identityMeta, 10),
        pad(item.toolName || item.phase || "waiting", 12),
        pad(item.summary || "", Math.max(10, width - 73)),
        pad(queue, 5),
        pad(formatAge(item.heartbeatAgeMs), 6),
        pad(elapsed, 8),
      ];
      body.push(truncate(cols.join(" "), width));
    }
    body.push("");
  }

  if (rows.length === 0) {
    body.push(dim("No agent state files found yet."));
    body.push(dim("Install the package in Pi, then start an agent session."));
    body.push("");
  }

  const events = readEventTail();
  body.push(bold("RECENT EVENTS"));
  for (const event of events) {
    const label = [event.tmuxSessionName || event.projectName, event.type].filter(Boolean).join(" · ");
    const summary = event.toolName || event.summary || event.error || "";
    body.push(truncate(`${dim((event.ts || "").slice(11, 19))} ${label} ${dim(summary)}`, width));
  }

  const output = [...header, ...body].slice(0, height - 1);
  process.stdout.write("\x1b[H\x1b[2J" + output.join("\n") + "\n");
}

function scheduleRender() {
  needsRender = true;
  render();
}

function handleKey(data) {
  const key = String(data);
  if (key === "q" || key === "\u0003") {
    shutdown(0);
    return;
  }
  if (key === "f") {
    workingOnly = !workingOnly;
    scheduleRender();
    return;
  }
  if (key === "a") {
    showOffline = !showOffline;
    scheduleRender();
    return;
  }
  if (key === "r") {
    scheduleRender();
    return;
  }
}

function startWatcher() {
  ensureDir();
  try {
    watchHandle = fs.watch(agentsDir, { persistent: false }, () => {
      scheduleRender();
    });
  } catch {
    watchHandle = undefined;
  }
}

function shutdown(code = 0) {
  if (intervalHandle) clearInterval(intervalHandle);
  if (watchHandle) watchHandle.close();
  process.stdin.setRawMode?.(false);
  process.stdin.pause();
  restoreScreen();
  process.exit(code);
}

function main() {
  ensureDir();
  clearScreen();
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", handleKey);
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.stdout.on("resize", scheduleRender);
  intervalHandle = setInterval(scheduleRender, refreshMs);
  startWatcher();
  scheduleRender();
}

main();
