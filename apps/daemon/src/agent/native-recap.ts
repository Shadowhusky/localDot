import { existsSync, readFileSync } from "node:fs";
import { earlierRecord, type LocalDotEvent, type TranscriptMessage } from "@localdot/protocol";
import { parseLine } from "../event-file.ts";
import { untrusted } from "./untrusted.ts";

// Claude Code and Codex keep their conversations in memory only, so each new run of theirs starts
// from this record. What a tool returned stays in the task's log; the newest of it comes along.
const WORK_BYTES = 64 * 1024;
const OUTPUT_CHARS = 2000;
const SAID_CHARS = 24_000;
const WORK_TYPES = /"type":"(?:step\.start|tool\.start|tool\.output|tool\.end|step\.end)"/;
const MARKS = { done: "x", doing: ">", skipped: "-", todo: " " } as const;

export function workEvents(file: string): LocalDotEvent[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  return text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .flatMap((line) => (WORK_TYPES.test(line) ? (parseLine(line) ?? []) : []));
}

// The task's steps, oldest first, as many as fit: what each was for, how it ended, and the end of
// what it printed. Output is as it was then, and the page or file that printed it can say anything.
export function workRecord(events: readonly LocalDotEvent[], maxBytes = WORK_BYTES): string {
  const steps = new Map<
    string,
    { intent?: string; title?: string; status: string; output: string }
  >();
  for (const event of events) {
    if (!event.step) continue;
    const step = steps.get(event.step) ?? { status: "unconfirmed", output: "" };
    if (event.type === "step.start") step.intent = event.data.intent;
    else if (event.type === "tool.start") step.title = `${event.data.tool}: ${event.data.title}`;
    else if (event.type === "tool.output")
      step.output = (step.output + event.data.chunk).slice(-OUTPUT_CHARS);
    else if (event.type === "step.end") step.status = event.data.status;
    else if (event.type !== "tool.end") continue;
    steps.set(event.step, step);
  }
  const kept: string[] = [];
  let used = 0;
  for (const step of [...steps.values()].reverse()) {
    const line = `[${step.status}] ${[step.intent, step.title].filter(Boolean).join(" | ")}`;
    const output = step.output ? `\n${untrusted("what this step printed", step.output)}` : "";
    const entry = used + Buffer.byteLength(line + output) <= maxBytes / 2 ? line + output : line;
    used += Buffer.byteLength(entry) + 1;
    if (used > maxBytes) break;
    kept.unshift(entry);
  }
  return kept.join("\n");
}

function said(messages: readonly TranscriptMessage[]): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const message of messages.toReversed()) {
    if (message.role !== "assistant" || typeof message.content !== "string") continue;
    used += message.content.length;
    if (used > SAID_CHARS) break;
    kept.unshift(message.content);
  }
  return kept;
}

export interface NativeRecap {
  task: string;
  plan: readonly { text: string; status: keyof typeof MARKS }[];
  earlier: readonly string[];
  messages: readonly TranscriptMessage[];
  work?: string | undefined;
  suffix?: string;
  note?: string | undefined;
  maxBytes: number;
}

// The prompt of a new run. What the user said always goes in; dot's own record makes way for it.
export function nativeRecap(recap: NativeRecap): string {
  const full = recapText(recap);
  if (Buffer.byteLength(full) <= recap.maxBytes) return full;
  const lighter = recapText({ ...recap, work: undefined });
  if (Buffer.byteLength(lighter) <= recap.maxBytes) return lighter;
  return recapText({ ...recap, work: undefined, messages: recap.messages.filter(fromUser) });
}

const fromUser = (message: TranscriptMessage) =>
  message.sourceInbox !== undefined && typeof message.content === "string";

function recapText({ task, plan, earlier, messages, work, suffix, note }: NativeRecap): string {
  const user = messages.filter(fromUser);
  const own = said(messages);
  const record = earlierRecord(earlier);
  return [
    "You are carrying on this task in a new run: localDot starts one after a finished turn, a hand-back or a dropped connection. The computer and its files are as you left them, and below is the record of what you did and said. It doesn't hold everything your tools returned, so read again what you need that it leaves out. This is routine and nothing was lost: don't tell the user you restarted or lost anything.",
    ...(record ? [record] : []),
    `The task: ${task}`,
    `The plan so far:\n${plan.length ? plan.map((item) => `[${MARKS[item.status]}] ${item.text}`).join("\n") : "(no plan yet)"}`,
    ...(user.length
      ? [`What the user said since the task:\n${user.map((m) => m.content).join("\n")}`]
      : []),
    ...(work ? [`Your steps so far, oldest first:\n${work}`] : []),
    ...(own.length ? [`Your messages to the user, oldest first:\n${own.join("\n")}`] : []),
    "Use the full screenshot in this turn to see where things stand, then continue.",
    ...(suffix ? [suffix] : []),
    ...(note ? [note] : []),
  ].join("\n");
}
