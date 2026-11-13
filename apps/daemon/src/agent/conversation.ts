import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import {
  AgentRoleChoice,
  type AskFieldRecord,
  type ChangeTag,
  CONVERSATION_LIST,
  CONVERSATION_TASKS,
  CONVERSATION_WITHDRAWN,
  type ConversationEntry,
  type ConversationList,
  type ConversationOrganizedEvent,
  type ConversationSnapshot,
  ConversationTag,
  type CreateTag,
  DEFAULT_SMART_TAGS,
  EARLIER_CHARS,
  EARLIER_LEFT_OUT,
  EARLIER_TURN_CHARS,
  EARLIER_TURNS,
  isOwnWords,
  type LocalDotEvent,
  LookWearables,
  messageName,
  NamedTag,
  type PersonaId,
  SmartTagOptions,
  TAG_LIBRARY,
  TAGS_PER_CONVERSATION,
  TagId,
  type TagOnConversation,
  ULID_PATTERN,
  ulid,
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
// Beside a task's log, as an ended task's record never grows: the model chosen for its conversation.
const modelFile = (sessionId: string) => `sessions/${sessionId}/model.json`;
const MODEL_BYTES = 4 * 1024;
const TaskModel = z.strictObject({ v: z.literal(1), choice: AgentRoleChoice });
const Withdrawn = z.strictObject({
  v: z.literal(1),
  messages: z.array(z.string().regex(ULID_PATTERN)),
});
// How the user organized each conversation, by its first task, which stays its own as it goes on.
const ORGANIZED_FILE = "conversations-organized.json";
const ORGANIZED_BYTES = 4 * 1024 * 1024;
const Organized = z.strictObject({
  // Its one colour, from before tags had names.
  tag: ConversationTag.optional(),
  tags: z.array(TagId).max(TAGS_PER_CONVERSATION).optional(),
  pinned: z.literal(true).optional(),
  // Its latest task when it was archived: a task that goes on with it brings it back.
  archived: z.string().regex(ULID_PATTERN).optional(),
  look: LookWearables.optional(),
});
type Organized = z.infer<typeof Organized>;
const OrganizedFile = z.strictObject({
  v: z.literal(1),
  conversations: z.record(z.string().regex(ULID_PATTERN), Organized),
});
export type ConversationOrganization = Omit<ConversationOrganizedEvent, "type">;
export interface OrganizeConversation {
  tags?: readonly TagId[];
  pinned?: boolean;
  archived?: boolean;
  look?: LookWearables | null;
}
// The tags the user named, and how dot sorts conversations into them.
const TAGS_FILE = "conversation-tags.json";
const TAGS_BYTES = 256 * 1024;
const TagsFile = z.strictObject({
  v: z.literal(1),
  tags: z.array(NamedTag).max(TAG_LIBRARY),
  smart: SmartTagOptions.optional(),
});
type TagsFile = z.infer<typeof TagsFile>;
const tagIdsOf = (record: Organized | undefined): TagId[] =>
  record?.tags ?? (record?.tag ? [record.tag] : []);
const sameName = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
export class TagError extends Error {}
// A session.start and the task's first message sit in the first lines of a task's log.
const HEAD_BYTES = 16 * 1024;
const HEAD_EVENTS = 8;
// The dot a task starts as, and Auto's pick, sit in these first lines however late the pick came.
const DOT_EVENTS = 24;
// Without a saved choice, the latest of this many recent sessions that is a task is current.
const LOOK_BACK = 20;
// What an ended task said never changes, so the tasks read back most often are kept.
const KEPT_TASKS = 64;
const TURN_TYPES =
  /"type":"(?:message\.user|message\.delivery|message\.assistant|ask\.request|ask\.answer|task\.result|session\.end|plan\.set|step\.start|tool\.start|step\.end|action\.intent|action\.target)"/;
const PERSONA_CHOICE = /"type":"persona\.choice"/;
// The list of conversations reads through this many of the newest sessions.
const LIST_SCAN = 200;
// A task's session.end is among the last lines of its log.
const TAIL_BYTES = 4 * 1024;
const SESSION_END = /"type":"session\.end"/;
// A message is at most 20,000 characters, so the last one is whole in this much of a log's end.
const SAID_BYTES = 128 * 1024;
const DOT_SAID = /"type":"message\.assistant"/;
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
  "message.queue",
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
  const line = messageName(text).trim().split("\n")[0]?.trim() ?? "";
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
  readonly #dots = new Map<string, PersonaId | undefined>();
  readonly #saidLines = new Map<string, { size: number; line?: string }>();
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
    return this.snapshotOf(this.current());
  }

  // The conversation that ends with this task, as the app shows it.
  snapshotOf(current: string | null): ConversationSnapshot {
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
    // What came through a shared link is never taken for the owner's own words.
    const said = (data: { text: string; link?: string | undefined }) =>
      `${data.link ? "Someone with a shared link" : "The user"}: ${clip(data.text)}`;
    const waiting = new Map<string, { text: string; link?: string | undefined }>();
    for (const event of events) {
      switch (event.type) {
        case "message.user":
          if (unsaid.has(event.data.messageId)) break;
          if (event.data.queued) waiting.set(event.data.messageId, event.data);
          else turns.push(said(event.data));
          break;
        case "message.delivery": {
          const message = waiting.get(event.data.messageId);
          waiting.delete(event.data.messageId);
          if (
            message !== undefined &&
            (event.data.state === "sent" || event.data.state === "steering")
          )
            turns.push(said(message));
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
        turns.push(
          clip(`Recorded task progress; verify live state before acting:
${checkpoint}`),
        );
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

  // The model chosen for the conversation that ends with this task, as its newest choice says.
  model(sessionId: string): AgentRoleChoice | undefined {
    for (const id of this.chain(sessionId).sessions.reverse())
      try {
        const text = this.#files.text(modelFile(id), MODEL_BYTES);
        if (text !== undefined) return TaskModel.parse(JSON.parse(text)).choice;
      } catch {
        /* A choice that can't be read leaves the older one, or the default. */
      }
    return undefined;
  }

  chooseModel(sessionId: string, choice: AgentRoleChoice): void {
    this.#files.write(modelFile(sessionId), `${JSON.stringify({ v: 1, choice })}\n`);
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

  #head(sessionId: string, events = HEAD_EVENTS): LocalDotEvent[] {
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
        .slice(0, events)
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

  // The shared link a task works for, as its session.start records it.
  link(sessionId: string): { id: string; apps: boolean } | undefined {
    if (!this.has(sessionId)) return undefined;
    const start = this.#head(sessionId).find((event) => event.type === "session.start");
    return start?.type === "session.start" ? start.data.link : undefined;
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
  // `keep`, given, lists only the conversations whose tasks it keeps, as a shared link's own.
  list(
    max = CONVERSATION_LIST,
    archived = false,
    keep?: (sessions: readonly string[]) => boolean,
  ): Required<ConversationList> {
    const records = this.#organized();
    const library = this.tags();
    const found = (keep ? this.#found().filter((each) => keep(each.sessions)) : this.#found()).map(
      (conversation) => ({
        ...conversation,
        ...this.#organization(conversation.sessions[0] ?? "", records, library),
      }),
    );
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
      tags: this.tags(),
    };
  }

  // A routine started this task.
  fromRoutine(sessionId: string): boolean {
    return (
      this.#head(sessionId).find((event) => event.type === "session.start")?.data.origin?.kind ===
      "routine"
    );
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
    const records = this.#organized();
    const library = this.tags();
    this.#refile(records, latest, change, library);
    this.#saveOrganized(records);
    return this.#organization(latest, records, library);
  }

  // Gives each conversation all the tags it carries now, in one write.
  retag(changes: readonly { sessionId: string; tags: readonly TagId[] }[]): void {
    const records = this.#organized();
    const library = this.tags();
    for (const { sessionId, tags } of changes)
      this.#refile(records, this.latest(sessionId), { tags }, library);
    this.#saveOrganized(records);
  }

  // The tags a conversation carries, by id.
  tagsOf(sessionId: string): TagId[] {
    return tagIdsOf(this.#organized().get(this.#root(this.latest(sessionId))));
  }

  // The tags the user named.
  tags(): NamedTag[] {
    return this.#tagsFile().tags;
  }

  // A tag named as one the user has is that one.
  createTag({ name, color }: CreateTag): NamedTag {
    const file = this.#tagsFile();
    const same = file.tags.find((tag) => sameName(tag.name, name));
    if (same) return same;
    if (file.tags.length >= TAG_LIBRARY) throw new TagError("You have as many tags as dot keeps.");
    const tag: NamedTag = { id: ulid(), name, color };
    this.#saveTags({ ...file, tags: [...file.tags, tag] });
    return tag;
  }

  changeTag(id: string, change: ChangeTag): NamedTag | undefined {
    const file = this.#tagsFile();
    const was = file.tags.find((tag) => tag.id === id);
    if (!was) return undefined;
    if (
      change.name !== undefined &&
      file.tags.some((tag) => tag.id !== id && sameName(tag.name, change.name ?? ""))
    )
      throw new TagError("Another tag has that name.");
    const tag: NamedTag = { ...was, ...change };
    this.#saveTags({ ...file, tags: file.tags.map((each) => (each.id === id ? tag : each)) });
    return tag;
  }

  // The tag goes, and every conversation lets it go.
  deleteTag(id: string): boolean {
    const file = this.#tagsFile();
    if (!file.tags.some((tag) => tag.id === id)) return false;
    this.#saveTags({ ...file, tags: file.tags.filter((tag) => tag.id !== id) });
    const records = this.#organized();
    let changed = false;
    for (const [root, record] of records) {
      const ids = tagIdsOf(record);
      if (!ids.includes(id)) continue;
      changed = true;
      const { tag: _colour, tags: _tags, ...rest } = record;
      const kept = ids.filter((each) => each !== id);
      const next: Organized = { ...rest, ...(kept.length ? { tags: kept } : {}) };
      if (Object.keys(next).length) records.set(root, next);
      else records.delete(root);
    }
    if (changed) this.#saveOrganized(records);
    return true;
  }

  smartTagOptions(): SmartTagOptions {
    return this.#tagsFile().smart ?? DEFAULT_SMART_TAGS;
  }

  setSmartTagOptions(smart: SmartTagOptions): void {
    this.#saveTags({ ...this.#tagsFile(), smart });
  }

  #refile(
    records: Map<string, Organized>,
    latest: string,
    change: OrganizeConversation,
    library: readonly NamedTag[],
  ): void {
    const root = this.#root(latest);
    const was = records.get(root);
    const known = (id: TagId) =>
      ConversationTag.safeParse(id).success || library.some((tag) => tag.id === id);
    const tags = (change.tags ?? tagIdsOf(was)).filter(known);
    const pinned = change.pinned ?? !!was?.pinned;
    const archived = change.archived ?? was?.archived === latest;
    const look = change.look === undefined ? was?.look : (change.look ?? undefined);
    const next: Organized = {
      ...(tags.length ? { tags: [...new Set(tags)].slice(0, TAGS_PER_CONVERSATION) } : {}),
      ...(pinned ? { pinned: true } : {}),
      ...(archived ? { archived: latest } : {}),
      ...(look ? { look } : {}),
    };
    if (Object.keys(next).length) records.set(root, next);
    else records.delete(root);
  }

  #saveOrganized(records: Map<string, Organized>): void {
    for (const id of records.keys()) if (!this.log.hasSession(id)) records.delete(id);
    this.#files.write(
      ORGANIZED_FILE,
      `${JSON.stringify({ v: 1, conversations: Object.fromEntries(records) })}\n`,
    );
  }

  #tagsFile(): TagsFile {
    try {
      const text = this.#files.text(TAGS_FILE, TAGS_BYTES);
      if (text !== undefined) return TagsFile.parse(JSON.parse(text));
    } catch {
      console.error("the conversation tags could not be read");
    }
    return { v: 1, tags: [] };
  }

  #saveTags(file: TagsFile): void {
    this.#files.write(TAGS_FILE, `${JSON.stringify(file)}\n`);
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
    const { sessionId, sessions, tags, pinned, archived, look } = conversation;
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
    const firstTask = this.#root(sessionId);
    const end = this.#end(sessionId);
    let persona = end?.persona ?? this.#startingDot(sessionId);
    for (const id of [...sessions, firstTask]) persona ??= this.#dotOf(id);
    const line = this.#lastSaid(sessions);
    return {
      sessionId,
      sessions: sessions.slice(0, CONVERSATION_TASKS),
      title,
      said,
      ...(line ? { line } : {}),
      startedAt: new Date(Number.isFinite(started) ? started : ulidTime(sessionId)).toISOString(),
      ended: end?.reason ?? null,
      ...(tags.length ? { tags } : {}),
      ...(pinned ? { pinned } : {}),
      ...(archived ? { archived } : {}),
      firstTask,
      ...(persona ? { persona } : {}),
      ...(look ? { look } : {}),
    };
  }

  // The dot a task works as, which its conversation's look follows: what its session.end says it
  // ended as, else what it took up in its first lines.
  #dotOf(sessionId: string): PersonaId | undefined {
    return this.#end(sessionId)?.persona ?? this.#startingDot(sessionId);
  }

  // Auto's pick or the user's switch among a task's first lines, else what its session.start says.
  // Kept once those lines are all written, as they then never change.
  #startingDot(sessionId: string): PersonaId | undefined {
    if (this.#dots.has(sessionId)) return this.#dots.get(sessionId);
    const head = this.#head(sessionId, DOT_EVENTS);
    let dot: PersonaId | undefined;
    for (const event of head) {
      if (event.type === "session.start") dot ??= event.data.persona;
      else if (event.type === "persona.choice") dot = event.data.persona;
    }
    if (head.length >= DOT_EVENTS || this.#ending(sessionId)) {
      this.#dots.set(sessionId, dot);
      for (const old of this.#dots.keys()) {
        if (this.#dots.size <= KEPT_HEADS) break;
        this.#dots.delete(old);
      }
    }
    return dot;
  }

  #organization(
    latest: string,
    records: Map<string, Organized>,
    library: readonly NamedTag[],
  ): ConversationOrganization {
    const record = records.size ? records.get(this.#root(latest)) : undefined;
    return {
      sessionId: latest,
      tags: tagIdsOf(record).flatMap((id): TagOnConversation[] => {
        const colour = ConversationTag.safeParse(id);
        if (colour.success) return [{ id, color: colour.data }];
        const named = library.find((tag) => tag.id === id);
        return named ? [{ id, color: named.color, name: named.name }] : [];
      }),
      pinned: !!record?.pinned,
      archived: record?.archived === latest,
      look: record?.look ?? null,
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
    return this.#end(sessionId)?.reason ?? null;
  }

  #end(sessionId: string): Extract<LocalDotEvent, { type: "session.end" }>["data"] | null {
    const lines = this.#tail(sessionId, TAIL_BYTES)?.lines ?? [];
    for (let at = lines.length - 1; at >= 0; at--) {
      const line = lines[at] ?? "";
      if (!SESSION_END.test(line)) continue;
      const event = parseLine(line);
      if (event?.type === "session.end") return event.data;
    }
    return null;
  }

  // What dot last said in a conversation's newest task that says anything, kept until its log grows.
  #lastSaid(sessions: readonly string[]): string | undefined {
    for (const sessionId of sessions) {
      const size = this.#size(sessionId);
      const kept = this.#saidLines.get(sessionId);
      if (kept && kept.size === size) {
        if (kept.line) return kept.line;
        continue;
      }
      const lines = this.#tail(sessionId, SAID_BYTES)?.lines ?? [];
      let line: string | undefined;
      for (let at = lines.length - 1; at >= 0 && !line; at--) {
        const text = lines[at] ?? "";
        if (!DOT_SAID.test(text)) continue;
        const event = parseLine(text);
        if (event?.type === "message.assistant") line = firstLine(event.data.text) ?? undefined;
      }
      this.#saidLines.set(sessionId, { size, ...(line ? { line } : {}) });
      for (const old of this.#saidLines.keys()) {
        if (this.#saidLines.size <= KEPT_HEADS) break;
        this.#saidLines.delete(old);
      }
      if (line) return line;
    }
    return undefined;
  }

  #size(sessionId: string): number {
    try {
      return statSync(this.log.logFile(sessionId)).size;
    } catch {
      return 0;
    }
  }

  #tail(sessionId: string, length: number): { lines: string[] } | null {
    let fd: number | undefined;
    try {
      fd = openSync(
        this.log.logFile(sessionId),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const size = fstatSync(fd).size;
      const from = Math.max(0, size - length);
      const bytes = Buffer.alloc(size - from);
      const read = readSync(fd, bytes, 0, bytes.length, from);
      return { lines: bytes.subarray(0, read).toString("utf8").split("\n") };
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
