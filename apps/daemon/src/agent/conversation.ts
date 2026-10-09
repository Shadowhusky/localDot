import { closeSync, constants, existsSync, openSync, readFileSync, readSync } from "node:fs";
import {
  type AskFieldRecord,
  CONVERSATION_TASKS,
  type ConversationSnapshot,
  EARLIER_CHARS,
  EARLIER_LEFT_OUT,
  EARLIER_TURN_CHARS,
  EARLIER_TURNS,
  type LocalDotEvent,
  ULID_PATTERN,
} from "@localdot/protocol";
import { z } from "zod";
import { parseLine } from "../event-file.ts";
import type { EventLog } from "../event-log.ts";
import { PrivateFiles } from "./private-files.ts";

const FILE = "conversation.json";
const Stored = z.strictObject({
  v: z.literal(1),
  current: z.string().regex(ULID_PATTERN).nullable(),
});
// A session.start and the task's first message sit in the first lines of a task's log.
const HEAD_BYTES = 16 * 1024;
const HEAD_EVENTS = 8;
// Without a saved choice, the latest of this many recent sessions that is a task is current.
const LOOK_BACK = 20;
// What an ended task said never changes, so the tasks read back most often are kept.
const KEPT_TASKS = 64;
const TURN_TYPES =
  /"type":"(?:message\.user|message\.assistant|ask\.request|ask\.answer|task\.result|session\.end)"/;
const ENDINGS: Record<string, string> = {
  stopped: "(That task was stopped.)",
  error: "(That task ended with an error.)",
};

export type ConversationLog = Pick<EventLog, "hasSession" | "logFile" | "listSessions">;

const clip = (text: string) =>
  text.length > EARLIER_TURN_CHARS ? `${text.slice(0, EARLIER_TURN_CHARS)}…` : text;
// A field's answer as one line: a secret only as given.
const fieldText = (value: AskFieldRecord) =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.join(", ")
      : value === true
        ? "yes"
        : "(given, kept secret)";

// The conversation the next task continues. Each task names the one it continues in its
// session.start, so a conversation is a chain of tasks that survives restarts and ends where a
// task was deleted; only which chain is current is kept here.
export class Conversations {
  readonly #files: PrivateFiles;
  readonly #said = new Map<string, string[]>();
  constructor(
    home: string,
    private readonly log: ConversationLog,
  ) {
    this.#files = new PrivateFiles(home);
  }

  // The task the next one continues, or null when the next task starts a new conversation.
  current(): string | null {
    const stored = this.#stored();
    if (stored === undefined) return this.#latestTask();
    return stored && this.log.hasSession(stored) ? stored : null;
  }

  begin(): void {
    this.#write(null);
  }

  // Makes an earlier task's conversation current; false when there is no such task.
  select(sessionId: string): boolean {
    if (!this.has(sessionId)) return false;
    this.#write(sessionId);
    return true;
  }

  // A task that just started continues the current conversation, and is now its latest.
  adopt(sessionId: string): void {
    this.#write(sessionId);
  }

  snapshot(): ConversationSnapshot {
    const current = this.current();
    return current ? this.chain(current) : { sessions: [], more: false };
  }

  // The tasks of the conversation that ends with this one, oldest first.
  chain(sessionId: string, max = CONVERSATION_TASKS): ConversationSnapshot {
    const sessions: string[] = [];
    const seen = new Set<string>();
    let at: string | undefined = sessionId;
    while (at && !seen.has(at) && this.log.hasSession(at)) {
      if (sessions.length === max) return { sessions, more: true };
      seen.add(at);
      sessions.unshift(at);
      at = this.#head(at).find((event) => event.type === "session.start")?.data.continues;
    }
    return { sessions, more: false };
  }

  // What was said in the conversation up to and including this task, for the task that continues
  // it: the newest turns, as many as the record holds.
  earlier(sessionId: string): string[] {
    const chain = this.chain(sessionId);
    const turns: string[] = [];
    let used = 0;
    for (const id of chain.sessions.reverse()) {
      const own = this.#turns(id);
      for (let at = own.length - 1; at >= 0; at--) {
        const turn = own[at] ?? "";
        if (turns.length + 1 === EARLIER_TURNS || used + turn.length + 1 > EARLIER_CHARS)
          return [EARLIER_LEFT_OUT, ...turns];
        turns.unshift(turn);
        used += turn.length + 1;
      }
    }
    return chain.more ? [EARLIER_LEFT_OUT, ...turns] : turns;
  }

  #turns(sessionId: string): string[] {
    const kept = this.#said.get(sessionId);
    if (kept) return kept;
    const turns: string[] = [];
    const questions = new Map<string, Extract<LocalDotEvent, { type: "ask.request" }>["data"]>();
    let ended = false;
    for (const event of this.#events(sessionId)) {
      switch (event.type) {
        case "message.user":
          turns.push(`The user: ${clip(event.data.text)}`);
          break;
        case "message.assistant":
          if (event.data.text.trim()) turns.push(`dot: ${clip(event.data.text)}`);
          break;
        case "ask.request":
          questions.set(event.data.askId, event.data);
          turns.push(
            `dot asked: ${clip(
              [
                event.data.question,
                ...event.data.options.map((option) => `${option.key}: ${option.text}`),
                ...(event.data.fields ?? []).map((field) => `- ${field.label}`),
              ].join("\n"),
            )}`,
          );
          break;
        case "ask.answer": {
          if (event.data.by !== "user") break;
          if (event.data.declined) {
            turns.push("The user declined to answer.");
            break;
          }
          const asked = questions.get(event.data.askId);
          const option = asked?.options.find((choice) => choice.key === event.data.option)?.text;
          const fields = Object.entries(event.data.fields ?? {}).map(([id, value]) => {
            const label = asked?.fields?.find((field) => field.id === id)?.label ?? id;
            return `${label}: ${fieldText(value)}`;
          });
          const answer = [option, event.data.text, ...fields].filter(Boolean).join("\n");
          if (answer) turns.push(`The user answered: ${clip(answer)}`);
          break;
        }
        case "task.result": {
          const files = event.data.files.map((file) => file.name).join(", ");
          turns.push(
            `dot's result: ${clip(`${event.data.summary}${files ? `\nFiles: ${files}` : ""}`)}`,
          );
          break;
        }
        case "session.end": {
          ended = true;
          const ending = ENDINGS[event.data.reason];
          if (ending) turns.push(ending);
          break;
        }
      }
    }
    if (ended) {
      this.#said.set(sessionId, turns);
      for (const old of this.#said.keys()) {
        if (this.#said.size <= KEPT_TASKS) break;
        this.#said.delete(old);
      }
    } else if (turns.length) turns.push("(That task was interrupted.)");
    return turns;
  }

  // Only the lines that can be turns are parsed; a task's log is mostly its steps.
  #events(sessionId: string): LocalDotEvent[] {
    const file = this.log.logFile(sessionId);
    if (!existsSync(file)) return [];
    const text = readFileSync(file, "utf8");
    return text
      .slice(0, text.lastIndexOf("\n") + 1)
      .split("\n")
      .flatMap((line) => (TURN_TYPES.test(line) ? (parseLine(line) ?? []) : []));
  }

  #head(sessionId: string): LocalDotEvent[] {
    let fd: number | undefined;
    try {
      fd = openSync(
        this.log.logFile(sessionId),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const bytes = Buffer.alloc(HEAD_BYTES);
      const read = readSync(fd, bytes, 0, HEAD_BYTES, 0);
      const text = bytes.subarray(0, read).toString("utf8");
      return text
        .slice(0, text.lastIndexOf("\n") + 1)
        .split("\n")
        .slice(0, HEAD_EVENTS)
        .flatMap((line) => parseLine(line) ?? []);
    } catch {
      return [];
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  has(sessionId: string): boolean {
    return ULID_PATTERN.test(sessionId) && this.log.hasSession(sessionId);
  }

  #isTask(sessionId: string): boolean {
    return (
      this.has(sessionId) && this.#head(sessionId).some((event) => event.type === "message.user")
    );
  }

  #latestTask(): string | null {
    for (const session of this.log.listSessions().slice(0, LOOK_BACK))
      if (this.#isTask(session.id)) return session.id;
    return null;
  }

  // undefined: nothing chosen yet. A file that cannot be read counts as nothing chosen.
  #stored(): string | null | undefined {
    try {
      const text = this.#files.text(FILE, 1024);
      return text === undefined ? undefined : Stored.parse(JSON.parse(text)).current;
    } catch {
      return undefined;
    }
  }

  #write(current: string | null): void {
    this.#files.write(FILE, `${JSON.stringify({ v: 1, current })}\n`);
  }
}
