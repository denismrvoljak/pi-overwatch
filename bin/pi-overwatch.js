#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const rootDir = process.env.PI_OVERWATCH_DIR || path.join(os.homedir(), ".pi", "overwatch");
const agentsDir = path.join(rootDir, "agents");
const eventsFile = path.join(rootDir, "events.jsonl");
const configFile = path.join(rootDir, "config.json");
const refreshMs = Number(process.env.PI_OVERWATCH_REFRESH_MS || 1000);
const staleAfterMs = Number(process.env.PI_OVERWATCH_STALE_MS || 30000);
const statusTtlMs = Number(process.env.PI_OVERWATCH_STATUS_TTL_MS || 10 * 60 * 1000);

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
      statusline: userConfig?.statusline || {},
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

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function fg(hex, text) {
  const { r, g, b } = hexToRgb(hex);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

function boldFg(hex, text) {
  const { r, g, b } = hexToRgb(hex);
  return `\x1b[1;38;2;${r};${g};${b}m${text}\x1b[0m`;
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
    const win = agent.tmux.windowName || agent.tmux.windowIndex;
    const pane = [win, agent.tmux.paneIndex].filter(Boolean).join(".");
    return pane ? `tmux ${pane}` : "tmux";
  }
  if (agent.sessionName) return "pi session";
  return agent.cwd || "cwd";
}

export function readAgents(options = {}) {
  ensureDir();
  const files = fs.readdirSync(agentsDir).filter((file) => file.endsWith(".json"));
  const now = Date.now();
  const includeOffline = options.showOffline ?? showOffline;
  const includeExpired = options.includeExpired ?? includeOffline;

  return files
    .map((file) => {
      try {
        const fullPath = path.join(agentsDir, file);
        const state = JSON.parse(fs.readFileSync(fullPath, "utf8"));
        const heartbeatAgeMs = state.lastHeartbeatAt ? now - new Date(state.lastHeartbeatAt).getTime() : Infinity;
        const heartbeatExpired = heartbeatAgeMs > staleAfterMs;
        const computedStatus = state.status === "working" && heartbeatExpired ? "stale" : state.status;
        return {
          ...state,
          file: fullPath,
          computedStatus,
          heartbeatAgeMs,
          heartbeatExpired,
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
          heartbeatExpired: true,
        };
      }
    })
    .filter((agent) => (includeOffline ? true : agent.computedStatus !== "offline"))
    .filter(
      (agent) =>
        includeExpired ||
        !agent.heartbeatExpired ||
        (agent.computedStatus === "stale" && agent.heartbeatAgeMs <= statusTtlMs),
    )
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

function iconFor(status, colors) {
  switch (status) {
    case "working":
      return fg(colors.working, "●");
    case "done":
      return fg(colors.done, "✓");
    case "stale":
      return fg(colors.stale, "!");
    case "error":
      return fg(colors.error, "✕");
    case "offline":
      return fg(colors.dim, "○");
    default:
      return fg(colors.dim, "·");
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
  const colors = resolveStatusColors(config);
  const identityMode = config.dashboard.identity;
  const width = process.stdout.columns || 120;
  const height = process.stdout.rows || 40;
  const now = Date.now();
  const header = [
    boldFg(colors.heading, "OVERWATCH") + fg(colors.dim, `  ${rootDir}`),
    fg(colors.dim, `q quit  f working-only  a show-offline  r refresh  identity=${identityMode}`),
    "",
  ];

  const body = [];
  const groups = groupRows(rows);
  const orderedGroups = ["working", "stale", "done", "idle", "error", "offline"];
  for (const group of orderedGroups) {
    const items = groups.get(group);
    if (!items || items.length === 0) continue;
    body.push(boldFg(colors.heading, group.toUpperCase()));
    if (config.dashboard.showColumnHeader) {
      const headerCols = [
        pad(fg(colors.dim, "S"), 2),
        pad(fg(colors.dim, "TARGET"), 22),
        pad(fg(colors.dim, "WHERE"), 10),
        pad(fg(colors.dim, "DOING"), 12),
        pad(fg(colors.dim, "SUMMARY"), Math.max(10, width - 73)),
        pad(fg(colors.dim, "Q"), 5),
        pad(fg(colors.dim, "LAST"), 6),
        pad(fg(colors.dim, "RUN"), 8),
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
        pad(iconFor(item.computedStatus, colors), 2),
        pad(fg(colors.text, identity), 22),
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
    body.push(fg(colors.dim, "No agent state files found yet."));
    body.push(fg(colors.dim, "Install the package in Pi, then start an agent session."));
    body.push("");
  }

  const events = readEventTail();
  body.push(boldFg(colors.heading, "RECENT EVENTS"));
  for (const event of events) {
    const label = [event.tmuxSessionName || event.projectName, event.type].filter(Boolean).join(" · ");
    const summary = event.toolName || event.summary || event.error || "";
    body.push(truncate(`${fg(colors.dim, (event.ts || "").slice(11, 19))} ${label} ${fg(colors.dim, summary)}`, width));
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

// Rose Pine (https://rosepinetheme.com/) — Moon (dark) / Dawn (light).
const STATUS_THEMES = {
  dark: {
    text: "#e0def4",
    heading: "#c4a7e7",
    working: "#3e8fb0",
    stale: "#f6c177",
    done: "#9ccfd8",
    error: "#eb6f92",
    idle: "#908caa",
    dim: "#908caa",
    sep: "#6e6a86",
  },
  light: {
    text: "#575279",
    heading: "#907aa9",
    working: "#286983",
    stale: "#ea9d34",
    done: "#56949f",
    error: "#b4637a",
    idle: "#797593",
    dim: "#797593",
    sep: "#9893a5",
  },
};

// Known powerkit variant names, keyed by whether they render on a light background.
const LIGHT_POWERKIT_VARIANTS = new Set(["latte", "dawn"]);

function tmuxOption(name) {
  try {
    return execFileSync("tmux", ["show-options", "-gqv", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    }).trim();
  } catch {
    return "";
  }
}

function readSharedThemeMode() {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".config", "theme-mode"), "utf8").trim();
    return raw === "light" || raw === "dark" ? raw : undefined;
  } catch {
    return undefined;
  }
}

function resolveStatusColors(config, themeArg) {
  let theme = themeArg || config.statusline?.theme || "auto";
  if (theme === "auto") {
    const explicit = tmuxOption("@pi_overwatch_theme");
    if (explicit === "light" || explicit === "dark") {
      theme = explicit;
    } else {
      const shared = readSharedThemeMode();
      if (shared) {
        theme = shared;
      } else {
        const variant = tmuxOption("@powerkit_theme_variant");
        theme = LIGHT_POWERKIT_VARIANTS.has(variant) ? "light" : "dark";
      }
    }
  }
  const base = STATUS_THEMES[theme] || STATUS_THEMES.dark;
  return { ...base, ...(config.statusline?.colors || {}) };
}

const STATUS_ICONS = {
  working: "●",
  stale: "!",
  done: "✓",
  error: "✕",
  idle: "·",
};

function escapeTmux(text) {
  return String(text).replace(/#/g, "##");
}

function parseStatuslineArgs(args) {
  const options = { plain: false, session: undefined, max: 6, theme: undefined };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--plain") options.plain = true;
    else if (args[i] === "--session") options.session = args[++i];
    else if (args[i] === "--max") options.max = Math.max(1, Number(args[++i]) || 6);
    else if (args[i] === "--theme") options.theme = args[++i];
  }
  return options;
}

function printStatusline(args) {
  const options = parseStatuslineArgs(args);
  const style = (hex, text) => (options.plain ? text : `#[fg=${hex}]${text}#[default]`);
  const now = Date.now();
  const config = readConfig();
  const colors = resolveStatusColors(config, options.theme);

  const agents = readAgents({ includeExpired: true }).filter((agent) => {
    if (options.session && agent.tmux?.sessionName !== options.session) return false;
    if (agent.computedStatus === "working") return true;
    if (agent.computedStatus === "stale") return agent.heartbeatAgeMs <= statusTtlMs;
    const age = now - new Date(agent.updatedAt || 0).getTime();
    return age <= statusTtlMs;
  });

  if (agents.length === 0) {
    process.stdout.write(style(colors.dim, "○ pi idle") + "\n");
    return;
  }

  const labelCounts = new Map();
  for (const agent of agents) {
    const label = getIdentityLabel(agent, config.dashboard.identity);
    labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
  }

  const segments = agents.slice(0, options.max).map((agent) => {
    const status = agent.computedStatus;
    const icon = STATUS_ICONS[status] || STATUS_ICONS.idle;
    const hex = colors[status] || colors.idle;
    let label = getIdentityLabel(agent, config.dashboard.identity);
    if (labelCounts.get(label) > 1 && agent.tmux) {
      const win = agent.tmux.windowName || agent.tmux.windowIndex;
      const suffix = [win, agent.tmux.paneIndex].filter(Boolean).join(".");
      if (suffix) label = `${label}:${suffix}`;
    }
    const identity = escapeTmux(label);

    if (status === "working" || status === "stale") {
      const doing = escapeTmux(agent.toolName || agent.phase || "");
      const elapsed = agent.startedAt ? formatDuration(now - new Date(agent.startedAt).getTime()) : "";
      const detail = [doing, elapsed].filter(Boolean).join(" ");
      return `${style(hex, `${icon} ${identity}`)}${detail ? style(colors.dim, ` ${detail}`) : ""}`;
    }
    return style(hex, `${icon} ${identity}`);
  });

  const overflow = agents.length - options.max;
  if (overflow > 0) segments.push(style(colors.dim, `+${overflow}`));

  const separator = options.plain ? "  " : ` ${style(colors.sep, "·")} `;
  process.stdout.write(segments.join(separator) + "\n");
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

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const [, , command, ...cliArgs] = process.argv;
  if (command === "statusline") {
    printStatusline(cliArgs);
  } else {
    main();
  }
}
