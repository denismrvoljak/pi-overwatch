// Finds the agent process that owns a hook.
//
// A hook's parent may be a throwaway shell, so neither its pid nor its
// (missing) tty describe the agent. Walk up the process tree instead: the pid
// is the first ancestor named like the agent (`claude`, `codex`), which lets
// the dashboard notice when the agent exits without a SessionEnd. npm installs
// run the agent under `node`, so the nearest node ancestor is the fallback.
// The tty is the first ancestor that has one, which is where OSC 7501
// reports go.

import path from "node:path";
import { execFileSync } from "node:child_process";

function psInfo(pid) {
  try {
    const [ppid, tty, ...comm] = execFileSync("ps", ["-o", "ppid=,tty=,comm=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    })
      .trim()
      .split(/\s+/);
    return { ppid: Number(ppid), tty, comm: path.basename(comm.join(" ")) };
  } catch {
    return undefined;
  }
}

export function findAgentProcess(startPid, processNames) {
  const found = { pid: undefined, tty: undefined };
  let nodePid;
  for (let current = startPid, depth = 0; current > 1 && depth < 6; depth++) {
    const info = psInfo(current);
    if (!info) break;
    if (!found.tty && info.tty && !info.tty.startsWith("?")) {
      found.tty = info.tty.startsWith("/dev/") ? info.tty : `/dev/${info.tty}`;
    }
    if (!found.pid && processNames.some((name) => info.comm.startsWith(name))) found.pid = current;
    if (!nodePid && info.comm === "node") nodePid = current;
    if (found.pid && found.tty) break;
    current = info.ppid;
  }
  found.pid ??= nodePid;
  return found;
}
