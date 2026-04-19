import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type AgentStatus = "idle" | "working" | "done" | "error" | "offline";
type AgentPhase = "thinking" | "tool" | "waiting" | "queueing";

type TmuxInfo = {
  sessionName: string;
  windowIndex?: string;
  paneIndex?: string;
  paneId?: string;
  panePath?: string;
};

type AgentState = {
  agentId: string;
  pid: number;
  hostname: string;
  projectName: string;
  cwd: string;
  sessionFile?: string;
  sessionName?: string;
  tmux?: TmuxInfo;
  status: AgentStatus;
  phase: AgentPhase;
  toolName?: string;
  summary?: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
  lastHeartbeatAt: string;
  queue: {
    steering: number;
    followUp: number;
  };
};

const HEARTBEAT_MS = 5_000;
const MAX_EVENTS_FILE_BYTES = 5 * 1024 * 1024;
const TRIM_EVENTS_TO_LAST_LINES = 2_000;

function getRootDir(): string {
  return process.env.PI_OVERWATCH_DIR || path.join(os.homedir(), ".pi", "overwatch");
}

function sanitizeSummary(value: unknown, max = 120): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value.replace(/\s+/g, " ").trim();
  return compact ? compact.slice(0, max) : undefined;
}

function shortenPath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const normalized = filePath.replace(`${os.homedir()}/`, "~/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 3) return normalized;
  return `…/${parts.slice(-3).join("/")}`;
}

function firstLine(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return sanitizeSummary(value.split("\n").find((line) => line.trim().length > 0));
}

function summarizeToolStart(toolName: string, args: any): string {
  switch (toolName) {
    case "read":
      return `Reading ${shortenPath(args?.path) ?? "file"}`;
    case "write":
      return `Writing ${shortenPath(args?.path) ?? "file"}`;
    case "edit":
      return `Editing ${shortenPath(args?.path) ?? "file"}`;
    case "bash": {
      const command = firstLine(typeof args?.command === "string" ? args.command : undefined);
      return command ? `Running ${command}` : "Running command";
    }
    case "web_search": {
      const query = firstLine(typeof args?.query === "string" ? args.query : Array.isArray(args?.queries) ? args.queries[0] : undefined);
      return query ? `Searching ${query}` : "Searching web";
    }
    case "fetch_content": {
      const target = firstLine(typeof args?.url === "string" ? args.url : Array.isArray(args?.urls) ? args.urls[0] : undefined);
      return target ? `Fetching ${target}` : "Fetching content";
    }
    default:
      return toolName.replace(/_/g, " ");
  }
}

function summarizeToolText(toolName: string, text: string | undefined): string | undefined {
  const clean = firstLine(text);
  if (!clean) return undefined;

  if (toolName === "bash") {
    if (/^total \d+/.test(clean)) return "Listed directory contents";
    if (/^added |^removed |^modified /i.test(clean)) return clean;
  }

  return clean;
}

function safeMkdir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWriteText(filePath: string, text: string): void {
  safeMkdir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, text, "utf8");
  fs.renameSync(tempPath, filePath);
}

function atomicWriteJson(filePath: string, data: unknown): void {
  atomicWriteText(filePath, JSON.stringify(data, null, 2) + "\n");
}

function trimJsonlFile(filePath: string, maxBytes: number, keepLastLines: number): void {
  let stats: fs.Stats;
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

function appendJsonl(filePath: string, data: unknown): void {
  safeMkdir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(data) + "\n", "utf8");
  trimJsonlFile(filePath, MAX_EVENTS_FILE_BYTES, TRIM_EVENTS_TO_LAST_LINES);
}

function nowIso(): string {
  return new Date().toISOString();
}

function getTmuxInfo(): TmuxInfo | undefined {
  if (!process.env.TMUX) return undefined;

  try {
    const targetArgs = process.env.TMUX_PANE ? ["-t", process.env.TMUX_PANE] : [];
    const format = "#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_id}\t#{pane_current_path}";
    const output = execFileSync("tmux", ["display-message", "-p", ...targetArgs, format], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    }).trim();

    if (!output) return undefined;
    const [sessionName, windowIndex, paneIndex, paneId, panePath] = output.split("\t");
    if (!sessionName) return undefined;

    return {
      sessionName,
      windowIndex: windowIndex || undefined,
      paneIndex: paneIndex || undefined,
      paneId: paneId || process.env.TMUX_PANE || undefined,
      panePath: panePath || undefined,
    };
  } catch {
    return undefined;
  }
}

function getIdentityLabel(state: AgentState): string {
  return state.tmux?.sessionName || state.sessionName || state.projectName || path.basename(state.cwd || state.agentId);
}

export default function overwatch(pi: ExtensionAPI) {
  const rootDir = getRootDir();
  const agentsDir = path.join(rootDir, "agents");
  const eventsFile = path.join(rootDir, "events.jsonl");

  let state: AgentState | undefined;
  let heartbeat: NodeJS.Timeout | undefined;

  function agentFilePath(): string | undefined {
    return state ? path.join(agentsDir, `${state.agentId}.json`) : undefined;
  }

  function emitEvent(type: string, details: Record<string, unknown> = {}): void {
    if (!state) return;
    appendJsonl(eventsFile, {
      ts: nowIso(),
      type,
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

  function renderFooterStatus(ctx: any): void {
    if (!state || !ctx?.hasUI) return;
    const theme = ctx.ui.theme;
    const icon =
      state.status === "working"
        ? theme.fg("accent", "●")
        : state.status === "done"
          ? theme.fg("success", "✓")
          : state.status === "error"
            ? theme.fg("error", "!")
            : theme.fg("dim", "○");
    const body = `${getIdentityLabel(state)} · ${state.phase}${state.toolName ? `:${state.toolName}` : ""}`;
    ctx.ui.setStatus("overwatch", `${icon}${theme.fg("dim", ` ${body}`)}`);
  }

  function flush(ctx?: any): void {
    if (!state) return;
    state.updatedAt = nowIso();
    const filePath = agentFilePath();
    if (!filePath) return;
    atomicWriteJson(filePath, state);
    renderFooterStatus(ctx);
  }

  function touch(ctx?: any): void {
    if (!state) return;
    state.lastHeartbeatAt = nowIso();
    flush(ctx);
  }

  function stopHeartbeat(): void {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
  }

  function startHeartbeat(ctx?: any): void {
    stopHeartbeat();
    heartbeat = setInterval(() => {
      if (!state || state.status !== "working") return;
      state.lastHeartbeatAt = nowIso();
      flush(ctx);
    }, HEARTBEAT_MS);
  }

  pi.registerCommand("overwatch", {
    description: "Show Overwatch state file location",
    handler: async (_args, ctx) => {
      if (!state) {
        ctx.ui.notify("Overwatch has not initialized yet", "warning");
        return;
      }
      const filePath = agentFilePath();
      ctx.ui.notify(filePath ? `Overwatch: ${filePath}` : "Overwatch unavailable", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const cwd = process.cwd();
    const tmux = getTmuxInfo();
    const projectName = path.basename(cwd);
    const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
    const seed = `${os.hostname()}:${process.pid}:${tmux?.sessionName ?? "no-tmux"}:${cwd}:${sessionFile ?? "ephemeral"}`;
    const agentId = crypto.createHash("sha1").update(seed).digest("hex").slice(0, 12);
    const timestamp = nowIso();

    state = {
      agentId,
      pid: process.pid,
      hostname: os.hostname(),
      projectName,
      cwd,
      sessionFile,
      sessionName: pi.getSessionName() ?? undefined,
      tmux,
      status: "idle",
      phase: "waiting",
      updatedAt: timestamp,
      lastHeartbeatAt: timestamp,
      queue: { steering: 0, followUp: 0 },
    };

    flush(ctx);
    emitEvent("session_start", {
      reason: _event.reason,
      identity: getIdentityLabel(state),
      tmux,
    });
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!state) return;
    state.status = "working";
    state.phase = "thinking";
    state.toolName = undefined;
    state.summary = state.summary ?? "Working";
    state.startedAt = nowIso();
    state.finishedAt = undefined;
    touch(ctx);
    startHeartbeat(ctx);
    emitEvent("agent_start", { summary: state.summary });
  });

  pi.on("turn_start", async (_event, ctx) => {
    if (!state) return;
    state.status = "working";
    state.phase = "thinking";
    touch(ctx);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    if (!state) return;
    state.status = "working";
    state.phase = "tool";
    state.toolName = event.toolName;
    state.summary = summarizeToolStart(event.toolName, event.args);
    touch(ctx);
    emitEvent("tool_start", {
      toolName: event.toolName,
      summary: state.summary,
    });
  });

  pi.on("tool_execution_update", async (event, ctx) => {
    if (!state) return;
    state.status = "working";
    state.phase = "tool";
    state.toolName = event.toolName;

    const partialText = Array.isArray(event.partialResult?.content)
      ? event.partialResult.content
          .filter((item: any) => item?.type === "text")
          .map((item: any) => item.text)
          .join("\n")
      : undefined;

    state.summary = summarizeToolText(event.toolName, partialText) ?? state.summary ?? summarizeToolStart(event.toolName, event.args);
    touch(ctx);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (!state) return;
    const resultText = Array.isArray(event.result?.content)
      ? event.result.content
          .filter((item: any) => item?.type === "text")
          .map((item: any) => item.text)
          .join("\n")
      : undefined;

    if (event.isError) {
      state.status = "error";
      state.phase = "waiting";
      state.toolName = undefined;
      state.finishedAt = nowIso();
      state.summary = summarizeToolText(event.toolName, resultText) ?? `Tool failed: ${event.toolName}`;
      stopHeartbeat();
    } else {
      state.phase = "thinking";
      state.toolName = undefined;
      state.summary = summarizeToolText(event.toolName, resultText) ?? state.summary;
    }

    touch(ctx);
    emitEvent("tool_end", {
      toolName: event.toolName,
      isError: event.isError,
    });
  });

  pi.on("queue_update", async (event, ctx) => {
    if (!state) return;
    state.queue = {
      steering: event.steering.length,
      followUp: event.followUp.length,
    };
    if (event.steering.length > 0 || event.followUp.length > 0) {
      state.phase = "queueing";
    } else if (state.status === "working") {
      state.phase = state.toolName ? "tool" : "thinking";
    } else {
      state.phase = "waiting";
    }
    touch(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!state) return;
    state.status = state.status === "error" ? "error" : "done";
    state.phase = "waiting";
    state.toolName = undefined;
    state.finishedAt = nowIso();
    touch(ctx);
    stopHeartbeat();
    emitEvent("agent_end", { status: state.status });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!state) return;
    state.status = "offline";
    state.phase = "waiting";
    state.toolName = undefined;
    state.finishedAt = state.finishedAt ?? nowIso();
    touch(ctx);
    stopHeartbeat();
    emitEvent("session_shutdown");
  });
}
