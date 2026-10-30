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
  CONVERSATION_WITHDRAWN,
  type ConversationEntry,
  type ConversationList,
  type ConversationOrganizedEvent,
  type ConversationSnapshot,
  ConversationTag,
  EARLIER_CHARS,
  EARLIER_LEFT_OUT,
  EARLIER_TURN_CHARS,
  EARLIER_TURNS,
  isOwnWords,
  type LocalDotEvent,
  type PersonaId,
  ULID_PATTERN,
  ulidTime,
} from "@localdot/protocol";
import { z } from "zod";
import { parseLine, readValid } from "../event-file.ts";
import type { EventLog } from "../event-log.ts";
import { PrivateFiles } from "./private-files.ts";
import { taskCheckpoint } from "./task-checkpoint.ts";

const FILE = "conversation.json";
const Stored = z.strictObject({
  v: z.literal(1),
  current: z.string().regex(ULID_PATTERN).nullable(),
});
// Beside a task's log: the messages Stop left unsent that the user took back to edit.
const withdrawnFile = (sessionId: string) => `sessions/${sessionId}/withdrawn.json`;
const WITHDRAWN_BYTES = 64 * 1024;
const Withdrawn = z.strictObject({
  v: z.literal(1),
  messages: z.array(z.string().regex(ULID_PATTERN)),
});
// How the user organized each conversation, by its first task, which stays its own as it goes on.
const ORGANIZED_FILE = "conversations-organized.json";
const ORGANIZED_BYTES = 4 * 1024 * 1024;
const Organized = z.strictObject({
  tag: ConversationTag.optional(),
  pinned: z.literal(true).optional(),
  // Its latest task when it was archived: a task that goes on with it brings it back.
  archived: z.string().regex(ULID_PATTERN).optional(),
});
type Organized = z.infer<typeof Organized>;
const OrganizedFile = z.strictObject({
  v: z.literal(1),
  conversations: z.record(z.string().regex(ULID_PATTERN), Organized),
});
export type ConversationOrganization = Omit<ConversationOrganizedEvent, "type">;
export interface OrganizeConversation {
  tag?: ConversationTag | null;
  pinned?: boolean;
  archived?: boolean;
}
// A session.start and the task's first message sit in the first lines of a task's log.
const HEAD_BYTES = 16 * 1024;
const HEAD_EVENTS = 8;
// Without a saved choice, the latest of this many recent sessions that is a task is current.
const LOOK_BACK = 20;
// What an ended task said never changes, so the tasks read back most often are kept.
const KEPT_TASKS = 64;
const TURN_TYPES =
  /"type":"(?:message\.user|message\.delivery|message\.assistant|ask\.request|ask\.answer|task\.result|session\.end|plan\.set|tool\.start|step\.end|action\.intent|action\.target)"/;
const PERSONA_CHOICE = /"type":"persona\.choice"/;
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
// A task whose record holds only these carried nothing out: what was said and taken back, dot
// thinking, and looks at the screen.
const NOTHING_DONE = new Set<LocalDotEvent["type"]>([
  "session.start",
  "session.title",
  "persona.choice",
  "message.user",
  "message.delivery",
  "agent.state",
  "heartbeat",
  "thought.delta",
  "model.usage",
  "model.retry",
  "model.spend",
  "subscription.usage",
  "budget.exceeded",
  "screen.switch",
  "step.start",
  "observe",
  "step.end",
  "session.end",
]);

export type ConversationLog = Pick<
  EventLog,
  "hasSession" | "logFile" | "listSessions" | "titles" | "forget"
>;

interface TaskHead {
  continues: string | undefined;
  title: string | null;
  said: string | null;
}
// What a conversation is called: dot's name for it, else its first words, and the user's name,
// which wins.
export interface ConversationNames {
  automatic: string | null;
  user?: string;
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
// task was deleted; only which chain is current, and how the user organized each, are kept here.
export class Conversations {
  readonly #files: PrivateFiles;
  readonly #said = new Map<string, string[]>();
  readonly #heads = new Map<string, TaskHead>();
  readonly #links = new Map<string, string | undefined>();
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

  // A task that just started is now its conversation's latest. Given the task it continues, the
  // current conversation follows it only while it is still that one: the user may have moved on.
  adopt(sessionId: string, after?: string | null): void {
    if (after !== undefined && this.current() !== after) return;
    this.#write(sessionId);
  }

  snapshot(): ConversationSnapshot {
    const current = this.current();
    if (!current) return { sessions: [], more: false };
    const chain = this.chain(current);
    const withdrawn = chain.sessions.flatMap((id) => this.#withdrawn(id));
    return withdrawn.length
      ? { ...chain, withdrawn: withdrawn.slice(-CONVERSATION_WITHDRAWN) }
      : chain;
  }

  // Edit on a message Stop left unsent: its words, once the task's log shows Stop left it so. That
  // it was taken back is kept beside the log rather than in it, as Replay reads the log, and an
  // ended task's record would grow for it.
  withdrawStopped(sessionId: string, messageId: string): string | undefined {
    if (!this.has(sessionId) || !ULID_PATTERN.test(messageId)) return undefined;
    let text: string | undefined;
    let stopped = false;
    for (const event of this.#events(sessionId)) {
      if (event.type === "message.user" && event.data.messageId === messageId)
        text = event.data.text;
      else if (event.type === "message.delivery" && event.data.messageId === messageId)
        stopped = event.data.state === "cancelled" && event.data.reason === "stopped";
    }
    if (text === undefined || !stopped) return undefined;
    const kept = this.#withdrawn(sessionId);
    if (!kept.includes(messageId))
      this.#files.write(
        withdrawnFile(sessionId),
        `${JSON.stringify({ v: 1, messages: [...kept, messageId] })}\n`,
      );
    return text;
  }

  // A task Stop emptied before it carried anything out: its conversation is again the one it
  // continued, or a new one.
  leave(sessionId: string): void {
    if (this.current() !== sessionId) return;
    const continues = this.#head(sessionId).find((event) => event.type === "session.start")?.data
      .continues;
    this.#write(continues && this.log.hasSession(continues) ? continues : null);
  }

  // Once it has settled, such a task leaves no record, as long as its log shows nothing done and
  // every message in it given back. Nothing with a record of actions is ever removed.
  discard(sessionId: string): boolean {
    if (!this.has(sessionId)) return false;
    const events = readValid(this.log.logFile(sessionId)).events;
    const back = new Set(
      events.flatMap((event) =>
        event.type === "message.delivery" &&
        event.data.state === "withdrawn" &&
        event.data.reason === "stopped"
          ? [event.data.messageId]
          : [],
      ),
    );
    if (
      !events.some((event) => event.type === "session.end") ||
      events.some(
        (event) =>
          !NOTHING_DONE.has(event.type) ||
          (event.type === "message.user" && !back.has(event.data.messageId)),
      )
    )
      return false;
    this.log.forget(sessionId);
    this.#said.delete(sessionId);
    this.#heads.delete(sessionId);
    return true;
  }

  #withdrawn(sessionId: string): string[] {
    try {
      const text = this.#files.text(withdrawnFile(sessionId), WITHDRAWN_BYTES);
      return text === undefined ? [] : Withdrawn.parse(JSON.parse(text)).messages;
    } catch {
      return [];
    }
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
      at = this.#continues(at);
    }
    return { sessions, more: false };
  }

  // The task a session continues, as its session.start says; that never changes once written.
  #continues(sessionId: string): string | undefined {
    if (this.#links.has(sessionId)) return this.#links.get(sessionId);
    const start = this.#head(sessionId).find((event) => event.type === "session.start");
    if (!start) return undefined;
    this.#links.set(sessionId, start.data.continues);
    for (const old of this.#links.keys()) {
      if (this.#links.size <= KEPT_HEADS) break;
      this.#links.delete(old);
    }
    return start.data.continues;
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
    // A queued message reached dot when it was sent or steered, after what dot did while it waited.
    // One the user withdrew or cancelled, or that Stop gave back or left unanswered, is not said.
    const unsaid = new Set(
      events.flatMap((event) =>
        event.type === "message.delivery" &&
        (event.data.state === "cancelled" || event.data.state === "withdrawn")
          ? [event.data.messageId]
          : [],
      ),
    );
    const waiting = new Map<string, string>();
    for (const event of events) {
      switch (event.type) {
        case "message.user":
          if (unsaid.has(event.data.messageId)) break;
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
          // A task whose every word was taken back is not mentioned at all.
          const ending = ENDINGS[event.data.reason];
          if (ending && turns.length) turns.push(ending);
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

  // The dot the conversation that ends with this task works as, when one was chosen for it.
  persona(sessionId: string): PersonaId | undefined {
    for (const id of this.chain(sessionId).sessions.reverse()) {
      const chosen = this.#events(id, PERSONA_CHOICE).findLast(
        (event) => event.type === "persona.choice",
      );
      if (chosen?.type === "persona.choice") return chosen.data.persona;
    }
    return undefined;
  }

  // Only the lines of the types asked for are parsed; a task's log is mostly its steps.
  #events(sessionId: string, types = TURN_TYPES): LocalDotEvent[] {
    const file = this.log.logFile(sessionId);
    if (!existsSync(file)) return [];
    const text = readFileSync(file, "utf8");
    return text
      .slice(0, text.lastIndexOf("\n") + 1)
      .split("\n")
      .flatMap((line) => (types.test(line) ? (parseLine(line) ?? []) : []));
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

  // The names of the conversation that ends with this task, as its latest task holds them: the
  // user's own time on the computer only says what it was called when it started.
  names(sessionId: string): ConversationNames {
    const task = this.chain(sessionId)
      .sessions.reverse()
      .find((id) => this.isTask(id));
    const facts = task && this.#facts(task);
    if (!task || !facts)
      return {
        automatic:
          this.#head(sessionId).find((event) => event.type === "session.start")?.data.title ?? null,
      };
    const { autoTitle, userTitle } = this.log.titles(task);
    return { automatic: autoTitle ?? facts.title, ...(userTitle ? { user: userTitle } : {}) };
  }

  isTask(sessionId: string): boolean {
    return (
      this.has(sessionId) && this.#head(sessionId).some((event) => event.type === "message.user")
    );
  }

  #latestTask(): string | null {
    for (const session of this.log.listSessions().slice(0, LOOK_BACK))
      if (this.isTask(session.id)) return session.id;
    return null;
  }

  // The recent conversations, newest first, or the archived ones, and how many are archived. Those
  // pinned are kept before the rest are counted.
  list(max = CONVERSATION_LIST, archived = false): Required<ConversationList> {
    const records = this.#organized();
    const found = this.#found().map((conversation) => ({
      ...conversation,
      ...this.#organization(conversation.sessions[0] ?? "", records),
    }));
    const shown = found.filter((conversation) => conversation.archived === archived);
    const kept = new Set(
      [...shown.filter((each) => each.pinned), ...shown.filter((each) => !each.pinned)].slice(
        0,
        max,
      ),
    );
    return {
      conversations: shown.filter((each) => kept.has(each)).map((each) => this.#entry(each)),
      archivedCount: found.filter((each) => each.archived).length,
    };
  }

  // The latest task of the conversation this task is part of.
  latest(sessionId: string): string {
    return (
      this.#found().find((each) => each.sessions.includes(sessionId))?.sessions[0] ?? sessionId
    );
  }

  // Tags, pins or archives the conversation this task is part of; what the change leaves out stays.
  organize(sessionId: string, change: OrganizeConversation): ConversationOrganization {
    const latest = this.latest(sessionId);
    const root = this.#root(latest);
    const records = this.#organized();
    const was = records.get(root);
    const tag = change.tag === undefined ? was?.tag : (change.tag ?? undefined);
    const pinned = change.pinned ?? !!was?.pinned;
    const archived = change.archived ?? was?.archived === latest;
    const next: Organized = {
      ...(tag ? { tag } : {}),
      ...(pinned ? { pinned: true } : {}),
      ...(archived ? { archived: latest } : {}),
    };
    if (Object.keys(next).length) records.set(root, next);
    else records.delete(root);
    for (const id of records.keys()) if (!this.log.hasSession(id)) records.delete(id);
    this.#files.write(
      ORGANIZED_FILE,
      `${JSON.stringify({ v: 1, conversations: Object.fromEntries(records) })}\n`,
    );
    return { sessionId: latest, tag: tag ?? null, pinned, archived };
  }

  // The conversations among the newest sessions, newest first: each task joins the conversation of
  // the newer task that continues it.
  #found(): { sessions: string[]; startedAt: string }[] {
    const found: { sessions: string[]; startedAt: string }[] = [];
    const continuedBy = new Map<string, (typeof found)[number]>();
    for (const session of this.log.listSessions().slice(0, LIST_SCAN)) {
      const head = this.#facts(session.id);
      if (!head) continue;
      let conversation = continuedBy.get(session.id);
      continuedBy.delete(session.id);
      if (conversation) conversation.sessions.push(session.id);
      else {
        conversation = { sessions: [session.id], startedAt: session.startedAt };
        found.push(conversation);
      }
      if (head.continues) continuedBy.set(head.continues, conversation);
    }
    return found;
  }

  // The latest task's name names it, as the app's title does, and the oldest task read says what
  // was first asked.
  #entry(
    conversation: { sessions: string[]; startedAt: string } & ConversationOrganization,
  ): ConversationEntry {
    const { sessionId, sessions, tag, pinned, archived } = conversation;
    let title: string | null = null;
    let said: string | null = null;
    for (const id of sessions) {
      const head = this.#facts(id);
      if (!title) {
        const { autoTitle, userTitle } = this.log.titles(id);
        title = (userTitle ?? autoTitle ?? head?.title)?.trim().slice(0, 200) || null;
      }
      said = head?.said ?? said;
    }
    const started = Date.parse(conversation.startedAt);
    return {
      sessionId,
      sessions: sessions.slice(0, CONVERSATION_TASKS),
      title,
      said,
      startedAt: new Date(Number.isFinite(started) ? started : ulidTime(sessionId)).toISOString(),
      ended: this.#ending(sessionId),
      ...(tag ? { tag } : {}),
      ...(pinned ? { pinned } : {}),
      ...(archived ? { archived } : {}),
    };
  }

  #organization(latest: string, records: Map<string, Organized>): ConversationOrganization {
    const record = records.size ? records.get(this.#root(latest)) : undefined;
    return {
      sessionId: latest,
      tag: record?.tag ?? null,
      pinned: !!record?.pinned,
      archived: record?.archived === latest,
    };
  }

  #root(sessionId: string): string {
    return this.chain(sessionId, Number.MAX_SAFE_INTEGER).sessions[0] ?? sessionId;
  }

  #organized(): Map<string, Organized> {
    try {
      const text = this.#files.text(ORGANIZED_FILE, ORGANIZED_BYTES);
      return new Map(
        text === undefined
          ? []
          : Object.entries(OrganizedFile.parse(JSON.parse(text)).conversations),
      );
    } catch {
      return new Map();
    }
  }

  // A task's chain link, what it was called when it started and its first message; null for a
  // session that is not a task.
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
