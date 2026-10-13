// OSC 7501 program status reports (https://mitchellh.com/writing/program-status-osc7501).
//
// Overwatch states already follow the protocol's vocabulary; this turns one
// into the escape sequence so the terminal (Ghostty, Rex, …) can show it too.
// Hook processes have no controlling tty, so the report is written to the tty
// of the agent process that owns the hook instead.

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const PROTOCOL_STATES = new Set(["idle", "working", "done", "blocked", "error"]);
const BLOCKED_KINDS = new Set(["permission", "question", "auth"]);

function base64Text(value) {
  if (typeof value !== "string") return undefined;
  // The spec forbids control characters in decoded text.
  const clean = value.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 200);
  return clean ? Buffer.from(clean, "utf8").toString("base64") : undefined;
}

// `offline` is Overwatch's name for a finished session; the protocol clears it.
export function programStatusSequence({ status, kind, progress, app, id, title, msg }) {
  const pairs = [];
  if (status === "offline") {
    pairs.push("state=clear");
  } else if (PROTOCOL_STATES.has(status)) {
    pairs.push(`state=${status}`);
    if (status === "blocked" && BLOCKED_KINDS.has(kind)) pairs.push(`kind=${kind}`);
    if ((status === "working" || status === "blocked") && Number.isInteger(progress) && progress >= 0 && progress <= 100) {
      pairs.push(`progress=${progress}`);
    }
  } else {
    return undefined;
  }
  if (id) pairs.push(`id=${id}`);
  if (status !== "offline") {
    if (app) pairs.push(`app=${app}`);
    const encodedTitle = base64Text(title);
    if (encodedTitle) pairs.push(`title=${encodedTitle}`);
    const encodedMsg = base64Text(msg);
    if (encodedMsg) pairs.push(`msg=${encodedMsg}`);
  }
  return `\x1b]7501;${pairs.join(":")}\x1b\\`;
}

// tmux drops unknown OSCs; DCS passthrough (allow-passthrough on) forwards
// them to the outer terminal, with every ESC doubled.
export function wrapForTmux(sequence) {
  return `\x1bPtmux;${sequence.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
}

function psInfo(pid) {
  try {
    const [ppid, tty] = execFileSync("ps", ["-o", "ppid=,tty=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    })
      .trim()
      .split(/\s+/);
    return { ppid: Number(ppid), tty };
  } catch {
    return undefined;
  }
}

// The hook may run under a shell the agent spawned without a tty, so walk up
// to the first ancestor that has one: the agent's terminal (or tmux pane).
function ttyOf(pid) {
  for (let current = pid, depth = 0; current > 1 && depth < 4; depth++) {
    const info = psInfo(current);
    if (!info) return undefined;
    if (info.tty && !info.tty.startsWith("?")) return info.tty.startsWith("/dev/") ? info.tty : `/dev/${info.tty}`;
    current = info.ppid;
  }
  return undefined;
}

// Cached on the state as `tty`; callers pass `refresh` on the events that
// also re-resolve tmux pane info, so tool hooks skip `ps` entirely.
export function resolveAgentTty(state, refresh = false) {
  if (!refresh && state.tty) return state.tty;
  state.tty = ttyOf(state.pid);
  return state.tty;
}

export function emitProgramStatus(state, { app, enabled, refreshTty = false }) {
  if (!enabled) return;
  const sequence = programStatusSequence({
    status: state.status,
    kind: state.kind,
    progress: state.progress,
    app,
    id: state.agentId,
    title: state.tmux?.sessionName || state.sessionName || state.projectName,
    msg: state.summary,
  });
  if (!sequence) return;
  const ttyPath = resolveAgentTty(state, refreshTty);
  if (!ttyPath) return;
  try {
    fs.writeFileSync(ttyPath, process.env.TMUX ? wrapForTmux(sequence) : sequence, { flag: "a" });
  } catch {
    // terminal went away; nothing to report to
  }
}
