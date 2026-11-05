// Which names a person can read, shared by the dashboard and every producer.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Task tooling names tmux sessions with UUIDs (pax-worker-<uuid>-g13), and
// hook-based agent sessions are named by a short session-id prefix.
const GENERATED_NAME = /[0-9a-f]{8}-[0-9a-f]{4}-|^[0-9a-f]{8}$/;

export function readableName(name) {
  return name && !GENERATED_NAME.test(name) ? name : undefined;
}

// Session option the tmux status bar shows instead of the session name.
// Pax's supervisor finds workers by session name, so sessions get a label and
// are never renamed.
export const TMUX_TITLE_OPTION = "@pax-supervised-title";

function isLive(agent) {
  if (agent.status === "offline") return false;
  if (!Number.isInteger(agent.pid) || agent.pid <= 1 || (agent.hostname && agent.hostname !== os.hostname())) return true;
  try {
    process.kill(agent.pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function sharesSession(agentsDir, state) {
  let files = [];
  try {
    files = fs.readdirSync(agentsDir).filter((file) => file.endsWith(".json"));
  } catch {
    return false;
  }
  return files.some((file) => {
    try {
      const other = JSON.parse(fs.readFileSync(path.join(agentsDir, file), "utf8"));
      return other.agentId !== state.agentId && other.tmux?.sessionName === state.tmux.sessionName && isLive(other);
    } catch {
      return false;
    }
  });
}

// The title for a tmux session with a generated name, or `title: undefined`
// to clear it when several live agents share the session. Sessions you named
// yourself are left alone.
export function tmuxTitleFor(state, agentsDir) {
  const session = state.tmux?.sessionName;
  if (!session || readableName(session)) return undefined;
  if (sharesSession(agentsDir, state)) return { session, title: undefined };
  const title = readableName(state.sessionName);
  return title ? { session, title } : undefined;
}

export function tmuxTitleArgs({ session, title }) {
  // `=name:` matches the session exactly; without the colon tmux 3.6 rejects it.
  return title === undefined
    ? ["set-option", "-u", "-t", `=${session}:`, TMUX_TITLE_OPTION]
    : ["set-option", "-t", `=${session}:`, TMUX_TITLE_OPTION, title];
}
