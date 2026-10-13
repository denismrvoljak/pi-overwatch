// OSC 7501 program status reports (https://mitchellh.com/writing/program-status-osc7501).
//
// Overwatch states already follow the protocol's vocabulary; this turns one
// into the escape sequence so the terminal (Ghostty, Rex, …) can show it too.
// Hook processes have no controlling tty, so the report is written to the tty
// of the agent process that owns the hook instead (state.tty, see
// agent-process.js).

import fs from "node:fs";

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

export function emitProgramStatus(state, { app, enabled }) {
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
  const ttyPath = state.tty;
  if (typeof ttyPath !== "string") return;
  try {
    fs.writeFileSync(ttyPath, process.env.TMUX ? wrapForTmux(sequence) : sequence, { flag: "a" });
  } catch {
    // terminal went away; nothing to report to
  }
}
