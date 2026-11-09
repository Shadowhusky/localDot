import { existsSync } from "node:fs";
import { type LocalDotEvent, parseEvent } from "@localdot/protocol";
import { streamEventLines } from "../../sessions/ndjson.ts";

export type LogKind = "said" | "terminal" | "output" | "step" | "file" | "thought";
export interface LogLine {
  readonly seq: number;
  readonly kind: LogKind;
  readonly text: string;
}
export interface LoggedFrame {
  readonly frameId: string;
  readonly screen: "desktop" | "browser";
}
export interface TaskLog {
  readonly lines: readonly LogLine[];
  // The frames dot looked at, oldest first: each is masked as dot saw it.
  readonly frames: readonly LoggedFrame[];
  // Some of the oldest lines were dropped to keep the read bounded.
  readonly cut: boolean;
}

const LINE_CHARS = 16_000;
const PATCH_CHARS = 2_000;
const LOG_CHARS = 8_000_000;
const FRAMES_KEPT = 16;
const ENDINGS = { done: "finished", stopped: "was stopped", error: "ended with an error" };
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

// Lines of what happened in a task, for a side question's search. Typed text, keys, approval values
// and secret answers stay out, as they do from search and from dot's checkpoint.
export async function readTaskLog(file: string): Promise<TaskLog> {
  if (!existsSync(file)) return { lines: [], frames: [], cut: false };
  const lines: LogLine[] = [];
  const frames: LoggedFrame[] = [];
  const messages = new Map<string, LogLine>();
  const tools = new Map<string, string>();
  let screen: LoggedFrame["screen"] = "desktop";
  let open: { key: string; seq: number; kind: LogKind; text: string } | undefined;
  let size = 0;
  let cut = false;
  const close = () => {
    if (!open) return;
    push(open.seq, open.kind, open.text);
    open = undefined;
  };
  const push = (seq: number, kind: LogKind, text: string) => {
    const line = { seq, kind, text: clip(text.trim(), LINE_CHARS) };
    if (!line.text) return;
    lines.push(line);
    size += line.text.length;
    while (size > LOG_CHARS && lines.length > 1) {
      size -= lines.shift()?.text.length ?? 0;
      cut = true;
    }
  };
  // Output and thinking come in pieces; a search reads them whole.
  const grow = (key: string, seq: number, kind: LogKind, text: string) => {
    if (open?.key !== key) {
      close();
      open = { key, seq, kind, text: "" };
    }
    open.text = clip(open.text + text, LINE_CHARS);
  };
  const say = (event: LocalDotEvent, kind: LogKind, text: string | undefined) => {
    close();
    if (text) push(event.seq, kind, text);
  };
  for await (const raw of streamEventLines(file)) {
    let event: LocalDotEvent;
    try {
      event = parseEvent(JSON.parse(raw));
    } catch {
      continue;
    }
    switch (event.type) {
      case "message.user": {
        say(event, "said", `The user${event.data.queued ? " (queued)" : ""}: ${event.data.text}`);
        const said = lines.at(-1);
        if (said) messages.set(event.data.messageId, said);
        break;
      }
      case "message.delivery": {
        // A message the user took back was never said.
        const said = messages.get(event.data.messageId);
        if (said && (event.data.state === "cancelled" || event.data.state === "withdrawn")) {
          lines.splice(lines.indexOf(said), 1);
          size -= said.text.length;
          messages.delete(event.data.messageId);
        }
        break;
      }
      case "message.assistant":
        say(event, "said", event.data.text.trim() ? `dot: ${event.data.text}` : undefined);
        break;
      case "ask.request":
        say(event, "said", `dot asked: ${event.data.question}`);
        break;
      case "ask.answer":
        say(
          event,
          "said",
          event.data.by === "user" && event.data.text
            ? `The user answered: ${event.data.text}`
            : event.data.declined
              ? "The user declined."
              : undefined,
        );
        break;
      case "task.result":
        say(
          event,
          "said",
          `dot's result: ${event.data.summary}${event.data.files.length ? ` (files: ${event.data.files.map((f) => f.name).join(", ")})` : ""}`,
        );
        break;
      case "session.end":
        say(event, "said", `(The task ${ENDINGS[event.data.reason]}.)`);
        break;
      case "plan.set":
        say(
          event,
          "step",
          `Plan: ${event.data.items.map((item) => `[${item.status}] ${item.text}`).join("; ")}`,
        );
        break;
      case "step.start":
        say(event, "step", event.data.intent ? `Step: ${event.data.intent}` : undefined);
        break;
      case "tool.start":
        if (event.step) tools.set(event.step, event.data.tool);
        say(
          event,
          event.data.tool === "shell" ? "terminal" : "step",
          `${event.data.tool === "shell" ? "Ran" : event.data.tool}: ${event.data.title}`,
        );
        break;
      case "tool.output": {
        const shell = !!event.step && tools.get(event.step) === "shell";
        grow(
          `output:${event.step ?? ""}:${event.data.stream}`,
          event.seq,
          shell ? "terminal" : "output",
          event.data.chunk,
        );
        break;
      }
      case "step.end":
        say(
          event,
          "step",
          event.data.status !== "ok" || event.data.note
            ? `Step ${event.data.status}${event.data.note ? `: ${event.data.note}` : ""}`
            : undefined,
        );
        break;
      case "file.change":
        say(
          event,
          "file",
          `${event.data.op} ${event.data.path}${event.data.patch ? `\n${clip(event.data.patch, PATCH_CHARS)}` : ""}`,
        );
        break;
      case "action.intent":
        if (event.data.verb !== "type") say(event, "step", `Action: ${event.data.label}`);
        break;
      case "action.result":
        say(event, "step", event.data.error ? `Action failed: ${event.data.error}` : undefined);
        break;
      case "thought.delta":
        grow("thought", event.seq, "thought", event.data.text);
        break;
      case "agent.state":
        say(
          event,
          "step",
          event.data.state === "error"
            ? `dot hit a problem: ${event.data.reason ?? event.data.detail ?? "unknown"}`
            : undefined,
        );
        break;
      case "approval.request":
        say(event, "step", `dot asked for approval: ${event.data.title}`);
        break;
      case "approval.resolve":
        say(event, "step", `Approval: ${event.data.decision}`);
        break;
      case "takeover.request":
        say(event, "step", `The computer went to the user: ${event.data.note}`);
        break;
      case "takeover.end":
        say(event, "step", "The user handed the computer back.");
        break;
      case "research.source":
        say(event, "step", `Source: ${event.data.title ?? ""} ${event.data.url ?? ""}`);
        break;
      case "screen.switch":
        screen = event.data.screen;
        say(event, "step", `Switched to the ${screen === "browser" ? "web browser" : "desktop"}.`);
        break;
      case "observe":
        frames.push({ frameId: event.data.frameId, screen });
        if (frames.length > FRAMES_KEPT) frames.shift();
        break;
      default:
        break;
    }
  }
  close();
  return { lines, frames, cut };
}

const SNIPPET = 240;
function snippet(text: string, at: number, length: number): string {
  const from = Math.max(0, at - SNIPPET);
  const to = Math.min(text.length, at + length + SNIPPET);
  return `${from ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`;
}

export type LogScope = "all" | "terminal" | "messages";
const inScope = (line: LogLine, only: LogScope) =>
  only === "all" ||
  (only === "terminal" && line.kind === "terminal") ||
  (only === "messages" && line.kind === "said");

// The newest lines holding every word asked for, or failing that any of them.
export function searchLog(
  log: TaskLog,
  query: string,
  only: LogScope,
  limit: number,
): { seq: number; kind: LogKind; text: string }[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = log.lines.filter((line) => inScope(line, only));
  const find = (every: boolean) => {
    const found: { seq: number; kind: LogKind; text: string }[] = [];
    for (let i = lines.length - 1; i >= 0 && found.length < limit; i--) {
      const line = lines[i] as LogLine;
      const lower = line.text.toLowerCase();
      const hits = words.map((word) => lower.indexOf(word));
      if (every ? hits.some((at) => at < 0) : hits.every((at) => at < 0)) continue;
      const at = Math.min(...hits.filter((n) => n >= 0));
      found.push({
        seq: line.seq,
        kind: line.kind,
        text: snippet(line.text, at, words[0]?.length ?? 0),
      });
    }
    return found;
  };
  const all = find(true);
  return all.length ? all : find(false);
}

// Lines by position in the log: from a line on, or the newest ones.
export function readLog(
  log: TaskLog,
  { from, last, only = "all" }: { from?: number; last?: number; only?: LogScope },
  maxChars: number,
): LogLine[] {
  const lines = log.lines.filter((line) => inScope(line, only));
  const start =
    from === undefined
      ? Math.max(0, lines.length - (last ?? 40))
      : Math.max(
          0,
          lines.findIndex((line) => line.seq >= from),
        );
  const picked: LogLine[] = [];
  let used = 0;
  if (from === undefined) {
    for (let i = lines.length - 1; i >= start; i--) {
      const line = lines[i] as LogLine;
      if (used + line.text.length > maxChars && picked.length) break;
      used += line.text.length;
      picked.unshift(line);
    }
    return picked;
  }
  for (const line of lines.slice(start)) {
    if (used + line.text.length > maxChars && picked.length) break;
    used += line.text.length;
    picked.push(line);
  }
  return picked;
}
