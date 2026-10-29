import { readdirSync } from "node:fs";
import { arch, availableParallelism, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { ULID_PATTERN } from "@localdot/protocol";
import { REPORT_LOG_LINES } from "../../../../packages/protocol/src/reports.ts";
import { readHead, tailLines } from "./files.ts";

// The service logs of either kind of installation: launchd or systemd agents write <home>/logs,
// a release-managed one <home>/install/logs.
const LOGS = [
  "logs/daemon.log",
  "logs/keyd.log",
  "install/logs/daemon.log",
  "install/logs/daemon.error.log",
  "install/logs/keyd.log",
  "install/logs/keyd.error.log",
];
const LOG_WINDOW = 256 * 1024;
const EVENTS_WINDOW = 128 * 1024;
const RECENT_TASKS = 8;

export interface LogTail {
  name: string;
  lines: string[];
  truncated: boolean;
}

export function logTails(home: string): LogTail[] {
  return LOGS.flatMap((name) => {
    const tail = tailLines(join(home, name), LOG_WINDOW);
    if (!tail) return [];
    return [
      {
        name,
        lines: tail.lines.slice(-REPORT_LOG_LINES),
        truncated: !tail.whole || tail.lines.length > REPORT_LOG_LINES,
      },
    ];
  });
}

export interface TaskFacts {
  id: string;
  startedAt?: string;
  durationMs?: number;
  ended?: "done" | "stopped" | "error";
  verdict?: string;
  steps?: number;
  failedSteps?: number;
  states: { state: string; reason?: string; detail?: string }[];
  retries: { status?: number; message: string }[];
  models: string[];
  // What the user asked for; read only for the task a report is about, when they include it.
  title?: string;
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const count = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
function record(file: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readHead(file) ?? "");
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// A task as its states and reasons, from the end of its event log and its summary: never its
// messages, screenshots or files.
function taskFacts(dir: string, id: string, withTitle: boolean): TaskFacts {
  const meta = record(join(dir, "session.json"));
  const summary = record(join(dir, "summary.json"));
  const facts: TaskFacts = { id, states: [], retries: [], models: [] };
  const startedAt = text(summary.startedAt) ?? text(meta.startedAt);
  if (startedAt && !Number.isNaN(Date.parse(startedAt)))
    facts.startedAt = new Date(startedAt).toISOString();
  facts.durationMs = count(summary.durationMs);
  facts.verdict = text(summary.verdict);
  facts.steps = count(summary.steps);
  facts.failedSteps = count(summary.failedSteps);
  if (withTitle) facts.title = text(meta.title);
  const models = new Set<string>();
  for (const line of tailLines(join(dir, "events.jsonl"), EVENTS_WINDOW)?.lines ?? []) {
    let event: { type?: unknown; data?: Record<string, unknown> };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const data = event.data ?? {};
    if (event.type === "session.end") {
      const reason = text(data.reason);
      if (reason === "done" || reason === "stopped" || reason === "error") facts.ended = reason;
    } else if (event.type === "agent.state") {
      const state = text(data.state);
      if (state && (data.reason || state === "error" || state === "done"))
        facts.states.push({
          state,
          ...(text(data.reason) ? { reason: text(data.reason) } : {}),
          ...(text(data.detail) ? { detail: text(data.detail) } : {}),
        });
    } else if (event.type === "model.retry") {
      const message = text(data.message);
      if (message)
        facts.retries.push({
          ...(Number.isInteger(data.status) ? { status: data.status as number } : {}),
          message,
        });
    } else if (event.type === "model.usage" || event.type === "model.spend") {
      const name = [text(data.route), text(data.model)].filter(Boolean).join(" ");
      if (name) {
        models.delete(name);
        models.add(name);
      }
    }
  }
  facts.states = facts.states.slice(-12);
  facts.retries = facts.retries.slice(-8);
  facts.models = [...models].slice(-4);
  return facts;
}

// The newest tasks, and the one a report is about even when it is older.
export function recentTasks(home: string, about?: string, withTitle = false): TaskFacts[] {
  let ids: string[];
  try {
    ids = readdirSync(join(home, "sessions"))
      .filter((name) => ULID_PATTERN.test(name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
  const chosen = ids.slice(0, RECENT_TASKS);
  if (about && ids.includes(about) && !chosen.includes(about)) chosen.push(about);
  return chosen.map((id) => taskFacts(join(home, "sessions", id), id, withTitle && id === about));
}

export function hostFacts() {
  return {
    os: platform(),
    arch: arch(),
    release: release(),
    node: process.version,
    cpus: availableParallelism(),
    memoryGB: Math.round(totalmem() / 2 ** 30),
  };
}
