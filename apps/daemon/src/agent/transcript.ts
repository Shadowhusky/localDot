import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  MAX_SUBAGENT_BRIEFS,
  SubagentBrief,
  TranscriptMessage,
  ULID_PATTERN,
} from "@localdot/protocol";
import { z } from "zod";

export const MAX_TRANSCRIPT_MESSAGE = 512 * 1024;
const MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024;
const BRIEFS = "subagents.json";
const MAX_BRIEFS_BYTES = 1024 * 1024;
const Briefs = z.strictObject({
  v: z.literal(1),
  briefs: z.array(SubagentBrief).max(MAX_SUBAGENT_BRIEFS),
});
const Record = z.discriminatedUnion("kind", [
  z.strictObject({ v: z.literal(1), kind: z.literal("message"), message: TranscriptMessage }),
  z.strictObject({
    v: z.literal(1),
    kind: z.literal("ack"),
    inboxAfter: z.number().int().nonnegative(),
  }),
]);
export class TranscriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptError";
  }
}
export interface TranscriptState {
  messages: TranscriptMessage[];
  inboxAfter: number;
}

// An append-only journal owns both records and delivery acknowledgement. Message records are
// fsynced before the separate ack record; a lost reply replays by source message ID. A torn final
// line is ignored and removed before the next append. Corruption in a completed line fails closed.
export class TranscriptStore {
  constructor(private readonly home: string) {}
  #file(sessionId: string, name = "transcript.jsonl"): string {
    if (!ULID_PATTERN.test(sessionId)) throw new TranscriptError("invalid session id");
    let dir = resolve(this.home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const child of ["sessions", sessionId]) {
      dir = join(dir, child);
      try {
        mkdirSync(dir, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new TranscriptError("unsafe transcript directory");
    }
    return join(dir, name);
  }
  // What each delegated agent was asked and had done, newest last, so that a later task in the
  // conversation can hand the work one left unfinished to a fresh agent.
  briefs(sessionId: string): SubagentBrief[] {
    const file = this.#file(sessionId, BRIEFS);
    if (!existsSync(file)) return [];
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_BRIEFS_BYTES)
        throw new TranscriptError("invalid subagent briefs");
      return Briefs.parse(JSON.parse(readFileSync(fd, "utf8"))).briefs;
    } finally {
      closeSync(fd);
    }
  }
  saveBrief(sessionId: string, brief: SubagentBrief): void {
    const briefs = [...this.briefs(sessionId).filter((b) => b.id !== brief.id), brief].slice(
      -MAX_SUBAGENT_BRIEFS,
    );
    const file = this.#file(sessionId, BRIEFS);
    const temp = `${file}.tmp`;
    const fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      if (!fstatSync(fd).isFile()) throw new TranscriptError("invalid subagent briefs");
      writeFileSync(fd, `${JSON.stringify({ v: 1, briefs })}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
  }
  #load(sessionId: string): TranscriptState & { bytes: number; file: string } {
    const file = this.#file(sessionId);
    if (!existsSync(file)) return { file, bytes: 0, messages: [], inboxAfter: 0 };
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES)
        throw new TranscriptError("invalid transcript file");
      bytes = readFileSync(fd);
      if (bytes.byteLength > MAX_TRANSCRIPT_BYTES)
        throw new TranscriptError("transcript is too large");
    } finally {
      closeSync(fd);
    }
    const completeBytes = bytes.lastIndexOf(10) + 1;
    const messages: TranscriptMessage[] = [];
    const sources = new Map<string, TranscriptMessage>();
    let inboxAfter = 0;
    let completed: string;
    try {
      completed = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, completeBytes),
      );
    } catch {
      throw new TranscriptError("invalid transcript encoding");
    }
    for (const line of completed.split("\n")) {
      if (!line) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        throw new TranscriptError("corrupt transcript record");
      }
      const parsed = Record.safeParse(raw);
      if (!parsed.success) throw new TranscriptError("invalid transcript record");
      const record = parsed.data;
      if (record.kind === "ack") {
        if (record.inboxAfter < inboxAfter)
          throw new TranscriptError("backwards transcript acknowledgement");
        inboxAfter = record.inboxAfter;
      } else {
        const message = record.message;
        const source = message.sourceInbox?.messageId;
        if (source && sources.has(source)) {
          if (!isDeepStrictEqual(sources.get(source), message))
            throw new TranscriptError("conflicting transcript source");
          continue;
        }
        if (source) sources.set(source, message);
        messages.push(message);
      }
    }
    return { file, bytes: completeBytes, messages, inboxAfter };
  }
  state(sessionId: string): TranscriptState {
    const { messages, inboxAfter } = this.#load(sessionId);
    return { messages, inboxAfter };
  }
  read(sessionId: string): TranscriptMessage[] {
    return this.state(sessionId).messages;
  }
  append(sessionId: string, values: TranscriptMessage[]): void {
    const state = this.#load(sessionId);
    const sources = new Map(
      state.messages.flatMap((m) => (m.sourceInbox ? [[m.sourceInbox.messageId, m] as const] : [])),
    );
    const lines: string[] = [];
    for (const value of values) {
      const message = TranscriptMessage.parse(value);
      const encoded = JSON.stringify(message);
      if (Buffer.byteLength(encoded) > MAX_TRANSCRIPT_MESSAGE)
        throw new TranscriptError("a transcript message is too large; screenshots go by frame id");
      const source = message.sourceInbox?.messageId;
      if (source && sources.has(source)) {
        if (!isDeepStrictEqual(sources.get(source), message))
          throw new TranscriptError("conflicting transcript source");
        continue;
      }
      if (source) sources.set(source, message);
      lines.push(`${JSON.stringify({ v: 1, kind: "message", message })}\n`);
    }
    if (lines.length) this.#write(state.file, state.bytes, lines.join(""));
  }
  acknowledge(sessionId: string, inboxAfter: number): void {
    const state = this.#load(sessionId);
    if (!Number.isSafeInteger(inboxAfter) || inboxAfter < state.inboxAfter)
      throw new TranscriptError("invalid transcript acknowledgement");
    if (inboxAfter === state.inboxAfter) return;
    this.#write(state.file, state.bytes, `${JSON.stringify({ v: 1, kind: "ack", inboxAfter })}\n`);
  }
  #write(file: string, offset: number, text: string): void {
    const bytes = Buffer.from(text);
    if (offset + bytes.byteLength > MAX_TRANSCRIPT_BYTES)
      throw new TranscriptError("transcript is too large");
    const fd = openSync(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    try {
      if (!fstatSync(fd).isFile()) throw new TranscriptError("invalid transcript file");
      ftruncateSync(fd, offset);
      let written = 0;
      while (written < bytes.byteLength) {
        const n = writeSync(fd, bytes, written, bytes.byteLength - written, offset + written);
        if (!n) throw new TranscriptError("transcript write made no progress");
        written += n;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
