import { setTimeout as sleep } from "node:timers/promises";
import { MANUAL_STREAM_CLOSE, ManualStreamInput, ULID_PATTERN } from "@localdot/protocol";
import { refuse, tokenSocketServer, type UpgradeRoute } from "../upgrade-router.ts";
import {
  deliverManualInput,
  type ManualDesktop,
  type ManualDesktopSource,
  ManualInputRejected,
  ManualInputUncertain,
  openManualDesktop,
} from "./manual-input.ts";
import { AgentError } from "./runner.ts";
import type { AgentSession, ManualLease } from "./session.ts";

const QUEUE_LIMIT = 4096;
const TEXT_LIMIT = 4000;
// Another of the user's tabs may be mid-input; its turn is short.
const BUSY_WAIT_MS = 2000;
const MESSAGE_BYTES = 64 * 1024;

type Down = Extract<ManualStreamInput, { kind: "down" }>;
interface Work {
  input?: ManualStreamInput;
  count: number;
}
export interface ManualStreamPeer {
  send(data: string): void;
  close(code: number, reason: string): void;
}

// The user's input while they hold control, delivered strictly in order through the same lease,
// checks and redaction as a single input. A burst of input holds one lease, and so does a button
// the user keeps down: hand-back and Stop wait for the stream to let go before control moves on.
export class ManualStream {
  readonly #session: AgentSession;
  readonly #requestId: string;
  readonly #desktop: ManualDesktopSource | undefined;
  readonly #peer: ManualStreamPeer;
  readonly #queue: ManualStreamInput[] = [];
  // Buttons down on the computer that nothing let go of yet.
  readonly #held = new Set<string>();
  // On a screen that takes clicks only, the press its release turns into a click.
  #pressed: Down | undefined;
  #done = 0;
  #ended = false;
  #pumping = false;
  #wake: (() => void) | undefined;

  constructor(
    session: AgentSession,
    requestId: string,
    desktop: ManualDesktopSource | undefined,
    peer: ManualStreamPeer,
  ) {
    this.#session = session;
    this.#requestId = requestId;
    this.#desktop = desktop;
    this.#peer = peer;
    void session
      .controlReleased(requestId)
      .then(() => this.end(MANUAL_STREAM_CLOSE.changed, "control ended"));
  }

  push(raw: unknown): void {
    if (this.#ended) return;
    const parsed = ManualStreamInput.safeParse(raw);
    if (!parsed.success || this.#queue.length >= QUEUE_LIMIT) {
      this.end(MANUAL_STREAM_CLOSE.invalid, "invalid input");
      return;
    }
    this.#queue.push(parsed.data);
    this.#wake?.();
    if (!this.#pumping) void this.#pump();
  }

  // Input still queued is dropped; one already reaching the computer finishes first.
  end(code: number, reason: string): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#queue.length = 0;
    this.#pressed = undefined;
    this.#wake?.();
    this.#peer.close(code, reason);
  }

  async #pump(): Promise<void> {
    this.#pumping = true;
    let lease: ManualLease | undefined;
    let access: ManualDesktop | undefined;
    let uncertain = false;
    try {
      lease = await this.#admit();
      access = openManualDesktop(this.#session, lease, this.#desktop);
      for (;;) {
        const work = this.#take(!!access.letGo);
        if (!work) {
          if (!this.#held.size || this.#ended) break;
          await this.#idle(lease.signal);
          continue;
        }
        if (work.input) await this.#deliver(lease, access, work.input);
        this.#done += work.count;
        this.#peer.send(JSON.stringify({ done: this.#done }));
      }
    } catch (error) {
      uncertain = error instanceof ManualInputUncertain;
      this.end(
        uncertain ? MANUAL_STREAM_CLOSE.uncertain : MANUAL_STREAM_CLOSE.changed,
        uncertain ? "input unconfirmed" : "control changed",
      );
    } finally {
      if (this.#held.size)
        try {
          await access?.letGo?.();
        } catch {
          uncertain = true;
        }
      this.#held.clear();
      try {
        access?.release();
      } catch {
        uncertain = true;
      }
      lease?.finish(uncertain);
      if (uncertain) this.end(MANUAL_STREAM_CLOSE.uncertain, "input unconfirmed");
      this.#pumping = false;
    }
    if (this.#queue.length && !this.#ended) void this.#pump();
  }

  async #admit(): Promise<ManualLease> {
    const deadline = Date.now() + BUSY_WAIT_MS;
    for (;;) {
      try {
        return this.#session.admitManual(this.#requestId, new AbortController().signal);
      } catch (error) {
        if (
          this.#ended ||
          Date.now() > deadline ||
          this.#session.pendingTakeover !== this.#requestId ||
          this.#session.manualControl !== "busy"
        )
          throw error;
        await sleep(15);
      }
    }
  }

  // A held button keeps the lease while the user decides where to let go.
  #idle(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => {
        signal.removeEventListener("abort", aborted);
        this.#wake = undefined;
        resolve();
      };
      const aborted = () => {
        this.#wake = undefined;
        reject(signal.reason);
      };
      if (signal.aborted) return aborted();
      this.#wake = done;
      signal.addEventListener("abort", aborted, { once: true });
    });
  }

  async #deliver(lease: ManualLease, access: ManualDesktop, input: ManualStreamInput) {
    if (input.kind === "down") this.#held.add(input.button);
    try {
      await deliverManualInput(lease, access, input);
    } catch (error) {
      if (
        !(error instanceof ManualInputRejected) &&
        !(error instanceof AgentError && error.status === 400)
      )
        throw error;
      // An input this screen refuses, or one outside the desktop, is skipped: nothing was sent.
      if (input.kind === "down") this.#held.delete(input.button);
      return;
    }
    if (input.kind === "up") this.#held.delete(input.button);
  }

  // The next input to deliver, or none: queued text joins into one typing call, and pointer moves
  // with no button down shrink to the last one.
  #take(holds: boolean): Work | undefined {
    if (this.#ended) return undefined;
    const input = this.#queue.shift();
    if (!input) return undefined;
    if (input.kind === "text") {
      let text = input.text,
        count = 1;
      for (let next = this.#queue[0]; next?.kind === "text"; next = this.#queue[0]) {
        if ([...text].length + [...next.text].length > TEXT_LIMIT) break;
        text += next.text;
        count++;
        this.#queue.shift();
      }
      return { input: { kind: "text", text }, count };
    }
    if (!holds) return this.#clicksOnly(input);
    // A press of a button already down, or a release of one that is up, changes nothing.
    if (input.kind === "down" && this.#held.has(input.button)) return { count: 1 };
    if (input.kind === "up" && !this.#held.has(input.button)) return { count: 1 };
    if (input.kind === "move" && !this.#held.size) {
      let last = input,
        count = 1;
      for (let next = this.#queue[0]; next?.kind === "move"; next = this.#queue[0]) {
        last = next;
        count++;
        this.#queue.shift();
      }
      return { input: last, count };
    }
    return { input, count: 1 };
  }

  #clicksOnly(input: ManualStreamInput): Work {
    if (input.kind === "move") return { count: 1 };
    if (input.kind === "down") {
      this.#pressed = input;
      return { count: 1 };
    }
    if (input.kind === "up") {
      const pressed = this.#pressed;
      this.#pressed = undefined;
      return pressed?.button === input.button
        ? {
            input: {
              kind: "click",
              at: pressed.at,
              button: pressed.button,
              count: 1,
              ...(pressed.mods ? { mods: pressed.mods } : {}),
            },
            count: 1,
          }
        : { count: 1 };
    }
    if (input.kind === "scroll" && input.mods) {
      const { mods: _, ...plain } = input;
      return { input: plain, count: 1 };
    }
    return { input, count: 1 };
  }
}

export function manualStreamRoute(deps: {
  session(id: string): AgentSession | undefined;
  manual: ManualDesktopSource | undefined;
}): UpgradeRoute {
  const wss = tokenSocketServer({ maxPayload: MESSAGE_BYTES });
  return {
    pattern: /^\/api\/agent\/sessions\/([^/]+)\/takeover\/([^/]+)\/stream$/,
    params: ["id", "requestId"],
    auth: "token",
    open({ req, socket, head, params }) {
      const id = params.id ?? "",
        requestId = params.requestId ?? "";
      if (!ULID_PATTERN.test(id) || !ULID_PATTERN.test(requestId)) {
        refuse(socket, "400 Bad Request");
        return;
      }
      const session = deps.session(id);
      if (!session || session.stopped) {
        refuse(socket, "404 Not Found");
        return;
      }
      if (
        session.pendingTakeover !== requestId ||
        (session.manualControl !== "ready" && session.manualControl !== "busy")
      ) {
        refuse(socket, "409 Conflict");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("error", () => {});
        const stream = new ManualStream(session, requestId, deps.manual, {
          send: (data) => {
            if (ws.readyState === ws.OPEN) ws.send(data);
          },
          close: (code, reason) => ws.close(code, reason),
        });
        ws.on("message", (data, binary) => {
          let parsed: unknown;
          try {
            parsed = binary ? undefined : JSON.parse(String(data));
          } catch {
            parsed = undefined;
          }
          stream.push(parsed);
        });
        ws.on("close", () => stream.end(1000, "closed"));
      });
    },
  };
}
