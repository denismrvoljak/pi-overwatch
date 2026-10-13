// Fire-and-forget tmux side effects for short-lived hook producers.
//
// Claude Code waits for a hook before it continues, and a busy tmux server can
// take seconds to answer. State is written synchronously; everything that only
// talks to tmux (status refresh, notifications, bell) runs here, detached, so
// the hook itself returns immediately.

import fs from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

function tmuxRun(args) {
  try {
    return execFileSync("tmux", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    }).trim();
  } catch {
    return undefined;
  }
}

function listClients() {
  return (tmuxRun(["list-clients", "-F", "#{client_name}"]) || "").split("\n").filter(Boolean);
}

function paneVisible(paneId) {
  const result = tmuxRun([
    "display-message",
    "-p",
    "-t",
    paneId,
    "#{&&:#{session_attached},#{&&:#{window_active},#{pane_active}}}",
  ]);
  return result === "1";
}

// A hook's stdout belongs to Claude Code, so the bell goes to the pane's tty.
function ringPaneBell(paneId) {
  const tty = tmuxRun(["display-message", "-p", "-t", paneId, "#{pane_tty}"]);
  if (!tty) return;
  try {
    fs.writeFileSync(tty, "\x07");
  } catch {
    // pane closed in the meantime
  }
}

export function runTmuxEffects({ refresh = false, message, paneId, bell = false } = {}) {
  const clients = listClients();
  if (refresh) {
    for (const client of clients) tmuxRun(["refresh-client", "-S", "-t", client]);
  }
  if (!message) return;
  if (paneId && paneVisible(paneId)) return;
  for (const client of clients) tmuxRun(["display-message", "-c", client, message]);
  if (bell && paneId) ringPaneBell(paneId);
}

export function spawnTmuxEffects(effects) {
  if (!process.env.TMUX) return;
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), JSON.stringify(effects)], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // never fail the hook over a status refresh
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    runTmuxEffects(JSON.parse(process.argv[2] || "{}"));
  } catch {
    // intentionally silent
  }
}
