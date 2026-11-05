// Where agent state lives, and env settings, shared by every reader and writer.
// The old pi-overwatch names still work so a half-upgraded setup keeps one folder.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function setting(name) {
  return process.env[`AGENTWATCH_${name}`] || process.env[`PI_OVERWATCH_${name}`];
}

export function stateDir() {
  const explicit = setting("DIR");
  if (explicit) return explicit;
  const current = path.join(os.homedir(), ".local", "state", "agentwatch");
  const legacy = path.join(os.homedir(), ".pi", "overwatch");
  return !fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current;
}
