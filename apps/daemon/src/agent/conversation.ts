import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import {
  type AskFieldRecord,
  CONVERSATION_LIST,
  CONVERSATION_TASKS,
  type ConversationEntry,
  type ConversationSnapshot,
  EARLIER_CHARS,
  EARLIER_LEFT_OUT,
  EARLIER_TURN_CHARS,
  EARLIER_TURNS,
  isOwnWords,
  type LocalDotEvent,
  ULID_PATTERN,
  ulidTime,
} from "@localdot/protocol";
import { z } from "zod";
import { parseLine } from "../event-file.ts";
import type { EventLog } from "../event-log.ts";
import { PrivateFiles } from "./private-files.ts";
import { taskCheckpoint } from "./task-checkpoint.ts";

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
  /"type":"(?:message\.user|message\.delivery|message\.assistant|ask\.request|ask\.answer|task\.result|session\.end|plan\.set|tool\.start|step\.end|action\.intent|action\.target)"/;
// The list of conversations reads through this many of the newest sessions.
const LIST_SCAN = 200;
// A task's session.end is among the last lines of its log.
const TAIL_BYTES = 4 * 1024;
const SESSION_END = /"type":"session\.end"/;
// What a task's first lines say never changes once its first message is in, so they are kept.
const KEPT_HEADS = 512;
const ENDINGS: Record<string, string> = {
  stopped: "(That task was stopped.)",
  error: "(That task ended with an error.)",
};

export type ConversationLog = Pick<EventLog, "hasSession" | "logFile" | "listSessions">;

interface TaskHead {
  continues: string | undefined;
  title: string | null;
  said: string | null;
}

const firstLine = (text: string) => {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line ? (line.length > 200 ? `${line.slice(0, 199)}…` : line) : null;
};

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
        : isOwnWords(value)
          ? [...(value.selected ?? []), value.other].join(", ")
          : "(given, kept secret)";

// The conversation the next task continues. Each task names the one it continues in its
// session.start, so a conversation is a chain of tasks that survives restarts and ends where a
// task was deleted; only which chain is current is kept here.
export class Conversations {
  readonly #files: PrivateFiles;
  readonly #said = new Map<string, string[]>();
  readonly #heads = new Map<string, TaskHead>();
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

  // Recall expands a match from this task only, never the entire conversation chain.
  taskContext(sessionId: string): string {
    if (!this.has(sessionId)) return "";
    return this.#turns(sessionId).slice(-4).join("\n").slice(-3000);
  }

  #turns(sessionId: string): string[] {
    const kept = this.#said.get(sessionId);
    if (kept) return kept;
    const turns: string[] = [];
    const questions = new Map<string, Extract<LocalDotEvent, { type: "ask.request" }>["data"]>();
    let ended = false;
    let completed = false;
    const events = this.#events(sessionId);
    // A queued message reached dot when it was sent or steered, after what dot did while it waited;
    // one the user withdrew or cancelled never did.
    const waiting = new Map<string, string>();
    for (const event of events) {
      switch (event.type) {
        case "message.user":
          if (event.data.queued) waiting.set(event.data.messageId, event.data.text);
          else turns.push(`The user: ${clip(event.data.text)}`);
          break;
        case "message.delivery": {
          const text = waiting.get(event.data.messageId);
          waiting.delete(event.data.messageId);
          if (
            text !== undefined &&
            (event.data.state === "sent" || event.data.state === "steering")
          )
            turns.push(`The user: ${clip(text)}`);
          break;
        }
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
          const label = (id: string) =>
            asked?.fields?.find((field) => field.id === id)?.label ?? id;
          const fields = Object.entries(event.data.fields ?? {}).map(
            ([id, value]) => `${label(id)}: ${fieldText(value)}`,
          );
          const skipped = (event.data.skipped ?? []).map((id) => `${label(id)}: left to dot`);
          const answer = [option, event.data.text, ...fields, ...skipped]
            .filter(Boolean)
            .join("\n");
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
          completed = event.data.reason === "done";
          const ending = ENDINGS[event.data.reason];
          if (ending) turns.push(ending);
          break;
        }
      }
    }
    if (!completed) {
      const checkpoint = taskCheckpoint(events);
      if (checkpoint)
        turns.push(`Recorded task progress; verify live state before acting:
${checkpoint}`);
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

  // What a task was called when it started.
  title(sessionId: string): string | undefined {
    return this.#head(sessionId).find((event) => event.type === "session.start")?.data.title;
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

  // The recent conversations, newest first: each task joins the conversation of the newer task that
  // continues it. The latest task's title names it, as the app's title does, and the oldest task
  // read says what was first asked.
  list(max = CONVERSATION_LIST): ConversationEntry[] {
    const listed: ConversationEntry[] = [];
    const continuedBy = new Map<string, ConversationEntry>();
    for (const session of this.log.listSessions().slice(0, LIST_SCAN)) {
      const head = this.#facts(session.id);
      if (!head) continue;
      let entry = continuedBy.get(session.id);
      continuedBy.delete(session.id);
      if (entry) {
        if (entry.sessions.length < CONVERSATION_TASKS) entry.sessions.push(session.id);
        entry.title ??= head.title;
        entry.said = head.said ?? entry.said;
      } else if (listed.length < max) {
        const started = Date.parse(session.startedAt);
        entry = {
          sessionId: session.id,
          sessions: [session.id],
          title: head.title,
          said: head.said,
          startedAt: new Date(
            Number.isFinite(started) ? started : ulidTime(session.id),
          ).toISOString(),
          ended: this.#ending(session.id),
        };
        listed.push(entry);
      }
      if (entry && head.continues) continuedBy.set(head.continues, entry);
    }
    return listed;
  }

  // A task's chain link, title and first message; null for a session that is not a task.
  #facts(sessionId: string): TaskHead | null {
    const kept = this.#heads.get(sessionId);
    if (kept) return kept;
    const head = this.#head(sessionId);
    const asked = head.find((event) => event.type === "message.user");
    if (!asked) return null;
    const start = head.find((event) => event.type === "session.start");
    const facts: TaskHead = {
      continues: start?.data.continues,
      title: start?.data.title?.trim().slice(0, 200) || null,
      said: firstLine(asked.data.text),
    };
    this.#heads.set(sessionId, facts);
    for (const old of this.#heads.keys()) {
      if (this.#heads.size <= KEPT_HEADS) break;
      this.#heads.delete(old);
    }
    return facts;
  }

  #ending(sessionId: string): ConversationEntry["ended"] {
    let fd: number | undefined;
    try {
      fd = openSync(
        this.log.logFile(sessionId),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const size = fstatSync(fd).size;
      const from = Math.max(0, size - TAIL_BYTES);
      const bytes = Buffer.alloc(size - from);
      const read = readSync(fd, bytes, 0, bytes.length, from);
      const lines = bytes.subarray(0, read).toString("utf8").split("\n");
      for (let at = lines.length - 1; at >= 0; at--) {
        const line = lines[at] ?? "";
        if (!SESSION_END.test(line)) continue;
        const event = parseLine(line);
        if (event?.type === "session.end") return event.data.reason;
      }
      return null;
    } catch {
      return null;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
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
