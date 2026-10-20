// biome-ignore-all lint/suspicious/noControlCharactersInRegex: remote text must have terminal control sequences stripped before display
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { stdin, stdout } from "node:process";
import { clearLine, createInterface, cursorTo } from "node:readline";
import { ULID_PATTERN } from "../../../packages/protocol/src/ids.ts";
import type { ConsoleIO, RuntimeContext } from "./runtime.ts";

// No terminal control sequences or invisible bidi overrides from remote/model output.
export const terminalText = (text: string) =>
  text
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))?/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
export function chatOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("Use an HTTPS server origin, or HTTP on loopback");
  return url.origin;
}
export function chatToken(path: string): string {
  if (!isAbsolute(path)) throw new Error("Use an absolute token-file path");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 512 ||
      stat.nlink !== 1 ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("The token file must be private to your account (chmod 600)");
    const token = readFileSync(fd, "utf8").trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid token file");
    return token;
  } finally {
    closeSync(fd);
  }
}
export class ChatHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function chatClient(
  origin: string,
  token: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
) {
  const base = chatOrigin(origin);
  return async <T>(path: string, body?: unknown): Promise<T> => {
    if (!path.startsWith("/api/") || path.includes("#") || /[\r\n]/.test(path))
      throw new Error("Invalid API path");
    const response = await fetchImpl(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    if (!response.ok)
      throw new ChatHttpError(
        response.status,
        response.status === 401
          ? "Access expired or was revoked. Reconnect with a valid credential."
          : response.status === 403
            ? "This link does not allow that action, or its limit was reached."
            : `Server returned ${response.status}. Check the app for details.`,
      );
    if (response.status === 204) return undefined as T;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty response");
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > 4 * 1024 * 1024)
          throw new Error(
            "History is too large for this terminal view. Open it in the app, or use /new.",
          );
        chunks.push(part.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  };
}
type Snapshot = {
  sessionId: string;
  status: string;
  toolCalls: number;
  pendingAsk?: string;
  approval?: unknown;
  pendingTakeover?: string;
  budgetHold?: string;
};
export async function chatSnapshot(
  call: ReturnType<typeof chatClient>,
  id: string,
): Promise<Snapshot> {
  try {
    return await call<Snapshot>(`/api/agent/sessions/${id}`);
  } catch (error) {
    if (!(error instanceof ChatHttpError) || error.status !== 404) throw error;
    const card = await call<{ verdict: string; steps: number }>(`/api/sessions/${id}/card`);
    if (!["done", "stopped", "failed", "interrupted"].includes(card.verdict)) throw error;
    return { sessionId: id, status: "ended", toolCalls: card.steps };
  }
}
type Cell = { id: string; state: string; fenced?: unknown; paused?: boolean };
type Event = {
  seq: number;
  type: string;
  data: { text?: string; title?: string; messageId?: string };
};
export async function runChat(context: RuntimeContext, io: ConsoleIO): Promise<number> {
  if (!stdin.isTTY || !stdout.isTTY) {
    io.err("localdot chat needs an interactive terminal.");
    return 2;
  }
  if (context.env.LOCALDOT_SERVER && !context.env.LOCALDOT_TOKEN_FILE) {
    io.err("Set LOCALDOT_TOKEN_FILE to the private credential file for that server.");
    return 2;
  }
  const origin = chatOrigin(context.env.LOCALDOT_SERVER ?? `http://127.0.0.1:${context.port}`);
  const token = chatToken(context.env.LOCALDOT_TOKEN_FILE ?? join(context.home, "daemon-token"));
  const local = new AbortController();
  const signal = AbortSignal.any([context.signal, local.signal]);
  const call = chatClient(origin, token, signal);
  await call("/api/whoami");
  const terminal = createInterface({
    input: stdin,
    output: stdout,
    prompt: "you › ",
    historySize: 0,
  });
  let session: string | undefined,
    seq = 0,
    status: Snapshot | null = null,
    reading = false,
    generation = 0,
    sending = false,
    lastProgress = "";
  const print = (text: string) => {
    clearLine(stdout, 0);
    cursorTo(stdout, 0);
    stdout.write(`${terminalText(text)}\n`);
    terminal.prompt(true);
  };
  const poll = async () => {
    if (reading || sending || signal.aborted) return;
    reading = true;
    const currentGeneration = generation;
    const stale = () => currentGeneration !== generation || signal.aborted;
    try {
      const cells = await call<Cell[]>("/api/cells");
      const cell =
        cells.find((c) => !c.fenced && c.state === "ready") ?? cells.find((c) => !c.fenced);
      const live = cell
        ? await call<{ sessionId: string } | undefined>(`/api/cells/${cell.id}/live`)
        : undefined;
      const conversation = live ? null : await call<{ sessions: string[] }>("/api/conversation");
      if (stale()) return;
      const next = live?.sessionId ?? conversation?.sessions.at(-1);
      if (next !== session) {
        session = next;
        seq = 0;
        status = null;
        lastProgress = "";
      }
      if (!session || !ULID_PATTERN.test(session)) return;
      const events = await call<Event[]>(`/api/sessions/${session}/events?fromSeq=${seq}`);
      if (stale()) return;
      for (const event of events) {
        if (!Number.isSafeInteger(event.seq) || event.seq < seq) continue;
        seq = event.seq + 1;
        if (event.type === "message.assistant" && event.data.text) {
          print(`dot › ${event.data.text}`);
        } else if (event.type === "tool.start" && event.data.title)
          print(`  · ${event.data.title}`);
      }
      const snapshot = await chatSnapshot(call, session);
      if (stale()) return;
      status = snapshot;
      const progress = `${status.status} · ${status.toolCalls} steps${status.pendingAsk || status.approval || status.pendingTakeover || status.budgetHold ? " · Needs attention in the app" : ""}`;
      if (progress !== lastProgress) {
        lastProgress = progress;
        print(progress);
      }
    } catch (error) {
      if (stale()) return;
      const message = error instanceof Error ? error.message : "Connection interrupted";
      if (message !== lastProgress) {
        lastProgress = message;
        print(message);
      }
    } finally {
      reading = false;
    }
  };
  terminal.on("line", (line) => {
    const text = line.trim();
    if (!text || sending) {
      terminal.prompt();
      return;
    }
    if (text === "/quit") {
      terminal.close();
      return;
    }
    if (text === "/help") {
      print(
        "/new — new chat · /status — current progress · /stop — stop this task · /quit — leave (task keeps running)",
      );
      return;
    }
    if (text === "/status") {
      void poll();
      return;
    }
    sending = true;
    generation += 1;
    void (async () => {
      try {
        if (text === "/new") {
          await call("/api/conversation/new", {});
          session = undefined;
          status = null;
          seq = 0;
          print("New conversation.");
        } else if (text === "/stop") {
          if (session) await call(`/api/agent/sessions/${session}/stop`, {});
        } else if (text.startsWith("/")) print("Unknown command. Use /help.");
        else {
          if (text.length > 8000) throw new Error("Keep a message under 8,000 characters.");
          const current = session ? await chatSnapshot(call, session) : null;
          if (
            current?.pendingAsk ||
            current?.approval ||
            current?.pendingTakeover ||
            current?.budgetHold ||
            current?.status === "paused"
          )
            throw new Error(
              "This task needs attention in the app. Complete that step before sending.",
            );
          if (session && current && ["running", "starting", "idle"].includes(current.status))
            await call(`/api/agent/sessions/${session}/messages`, {
              text,
              kind: current.status === "idle" ? "followup" : "steer",
            });
          else {
            const cells = await call<Cell[]>("/api/cells");
            const cell = cells.find((c) => !c.fenced && !c.paused && c.state === "ready");
            if (!cell) throw new Error("Turn on the computer in the app first.");
            const reply = await call<{ sessionId: string }>(`/api/cells/${cell.id}/agent`, {
              task: text,
            });
            session = reply.sessionId;
            seq = 0;
          }
        }
      } catch (error) {
        print(error instanceof Error ? error.message : "Request failed. Check the app.");
      } finally {
        sending = false;
        terminal.prompt();
        void poll();
      }
    })();
  });
  const abort = () => terminal.close();
  signal.addEventListener("abort", abort, { once: true });
  io.out(
    `Connected to ${origin}. Messages and progress stay in this terminal. /help for commands.`,
  );
  terminal.prompt();
  void poll();
  const timer = setInterval(() => void poll(), 1500);
  await new Promise<void>((resolve) => terminal.once("close", resolve));
  clearInterval(timer);
  signal.removeEventListener("abort", abort);
  local.abort();
  return 0;
}
