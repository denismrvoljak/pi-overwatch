import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function writeAgent(rootDir, state) {
  const agentsDir = path.join(rootDir, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, `${state.agentId}.json`), JSON.stringify(state));
}

function agentState(agentId, status, lastHeartbeatAt) {
  return {
    agentId,
    pid: process.pid,
    hostname: "test",
    projectName: "test",
    cwd: process.cwd(),
    status,
    phase: "waiting",
    updatedAt: lastHeartbeatAt,
    lastHeartbeatAt,
    queue: { steering: 0, followUp: 0 },
  };
}

test("keeps live idle rows and hides expired completed rows", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overwatch-dashboard-"));
  process.env.PI_OVERWATCH_DIR = rootDir;
  process.env.PI_OVERWATCH_STALE_MS = "30000";

  const fresh = new Date().toISOString();
  const expired = new Date(Date.now() - 60_000).toISOString();
  writeAgent(rootDir, agentState("fresh-done", "done", fresh));
  writeAgent(rootDir, agentState("expired-done", "done", expired));
  writeAgent(rootDir, agentState("expired-working", "working", expired));

  const moduleUrl = new URL(`../bin/pi-overwatch.js?test=${Date.now()}`, import.meta.url);
  const { readAgents } = await import(moduleUrl.href);
  const rows = readAgents();

  assert.equal(rows.find((row) => row.agentId === "fresh-done")?.computedStatus, "done");
  assert.equal(rows.some((row) => row.agentId === "expired-done"), false);
  assert.equal(rows.find((row) => row.agentId === "expired-working")?.computedStatus, "stale");

  const historyRows = readAgents({ showOffline: true });
  assert.equal(historyRows.find((row) => row.agentId === "expired-done")?.computedStatus, "done");

  fs.rmSync(rootDir, { recursive: true, force: true });
});

test("continues heartbeating after a turn ends until session shutdown", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overwatch-extension-"));
  process.env.PI_OVERWATCH_DIR = rootDir;

  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let heartbeat;
  let heartbeatUnrefCalled = false;
  globalThis.setInterval = (callback) => {
    heartbeat = { active: true, callback, unref: () => { heartbeatUnrefCalled = true; } };
    return heartbeat;
  };
  globalThis.clearInterval = (handle) => {
    handle.active = false;
  };

  try {
    const moduleUrl = new URL("../extensions/overwatch.ts", import.meta.url);
    moduleUrl.searchParams.set("test", String(Date.now()));
    const { default: overwatch } = await import(moduleUrl.href);
    const handlers = new Map();
    const pi = {
      getSessionName: () => "test session",
      on: (name, handler) => handlers.set(name, handler),
      registerCommand: () => {},
    };
    const ctx = {
      hasUI: false,
      sessionManager: { getSessionFile: () => "/tmp/test-session.jsonl" },
    };

    overwatch(pi);
    await handlers.get("session_start")({ reason: "startup" }, ctx);
    assert.equal(heartbeatUnrefCalled, true);
    await handlers.get("agent_start")({}, ctx);
    await handlers.get("agent_end")({}, ctx);

    const stateFile = fs.readdirSync(path.join(rootDir, "agents"))[0];
    const statePath = path.join(rootDir, "agents", stateFile);
    const beforeHeartbeat = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(beforeHeartbeat.status, "done");

    const expired = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(statePath, JSON.stringify({ ...beforeHeartbeat, lastHeartbeatAt: expired }));
    if (heartbeat.active) heartbeat.callback();
    const afterHeartbeat = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(afterHeartbeat.status, "done");
    assert.notEqual(afterHeartbeat.lastHeartbeatAt, expired);

    const dashboardUrl = new URL(`../bin/pi-overwatch.js?lifecycle=${Date.now()}`, import.meta.url);
    const { readAgents } = await import(dashboardUrl.href);
    assert.equal(readAgents().some((row) => row.agentId === afterHeartbeat.agentId), true);

    await handlers.get("session_shutdown")({ reason: "reload" }, ctx);
    assert.equal(heartbeat.active, false);
    const afterShutdown = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(afterShutdown.status, "offline");
    assert.equal(readAgents().some((row) => row.agentId === afterHeartbeat.agentId), false);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
