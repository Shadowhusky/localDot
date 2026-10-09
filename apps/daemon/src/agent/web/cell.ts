import { type KeydOpened, KeydOpened as OpenedSchema } from "@localdot/protocol";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import type { KeydClient } from "../../keyd/client.ts";
import { opensInWebBrowser } from "../tools/web-page.ts";
import { absolute } from "./html.ts";

export const WEB_CELL_ID = "web-tools";
const IDLE_MS = 2 * 60_000;
const TIMEOUT_MS = 20_000;
const REDIRECTS = 5;
// The web browser's own words, so pages answer as they would to it.
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export interface WebReply {
  // Where the page ended up, after any redirects.
  readonly url: URL;
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
  readonly truncated: boolean;
}
export interface WebGet {
  readonly signal: AbortSignal;
  readonly accept: string;
  readonly maxBytes: number;
}
export interface WebAccess {
  get(url: URL, options: WebGet): Promise<WebReply>;
}

export class WebError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebError";
  }
}

export interface WebCellDeps {
  keyd: Pick<KeydClient, "openCell" | "closeCell">;
  // A keyd listener port no computer or brain uses, and its return.
  ports: { reserve(): number; release(port: number): void };
  fetch?: typeof undiciFetch;
  idleMs?: number;
  timeoutMs?: number;
}
interface Open {
  readonly port: number;
  readonly agent: ProxyAgent;
}

// The daemon's own keyd listener for dot's web tools: the web browser's egress, with no key at
// all, so keyd checks every address it reaches and the user's sign-ins never come along. It opens
// on the first request and closes after a quiet spell, giving its port back.
export class WebCell implements WebAccess {
  #open: Promise<Open> | undefined;
  #idle: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly deps: WebCellDeps) {}

  async get(url: URL, options: WebGet): Promise<WebReply> {
    const signal = AbortSignal.any([
      options.signal,
      AbortSignal.timeout(this.deps.timeoutMs ?? TIMEOUT_MS),
    ]);
    let current = url;
    for (let hop = 0; hop <= REDIRECTS; hop++) {
      if (!opensInWebBrowser(current))
        throw new WebError("Only public web addresses on the usual ports can be read this way.");
      const cell = await this.#cell();
      signal.throwIfAborted();
      this.#rest();
      let reply: Response;
      try {
        reply = (await (this.deps.fetch ?? undiciFetch)(current, {
          method: "GET",
          headers: {
            "user-agent": USER_AGENT,
            accept: options.accept,
            "accept-language": "en-US,en;q=0.9",
          },
          dispatcher: cell.agent,
          redirect: "manual",
          signal,
        })) as unknown as Response;
      } catch (error) {
        // A listener keyd closed or lost answers nothing; the next request opens a fresh one.
        if (!options.signal.aborted && listenerLost(error)) await this.close();
        throw failure(error, signal, options.signal);
      }
      if ([301, 302, 303, 307, 308].includes(reply.status)) {
        await reply.body?.cancel().catch(() => {});
        const next = absolute(reply.headers.get("location") ?? undefined, current);
        if (!next) throw new WebError("The site redirected to an address that can't be read.");
        current = next;
        continue;
      }
      const { body, truncated } = await capped(reply, options.maxBytes, signal).catch(
        (error: unknown) => {
          throw failure(error, signal, options.signal);
        },
      );
      return {
        url: current,
        status: reply.status,
        contentType: (reply.headers.get("content-type") ?? "").toLowerCase(),
        body,
        truncated,
      };
    }
    throw new WebError("The site redirected too many times.");
  }

  #cell(): Promise<Open> {
    if (this.#open) return this.#open;
    const opening = this.#start();
    this.#open = opening;
    opening.catch(() => {
      if (this.#open === opening) this.#open = undefined;
    });
    return opening;
  }
  async #start(): Promise<Open> {
    // A listener left by an earlier run of the daemon is nobody's any more.
    await this.deps.keyd.closeCell(WEB_CELL_ID).catch(() => false);
    let port: number;
    try {
      port = this.deps.ports.reserve();
    } catch {
      throw new WebError("The web can't be reached: no connection is free for it right now.");
    }
    let opened: KeydOpened;
    try {
      opened = OpenedSchema.parse(
        await this.deps.keyd.openCell({ cellId: WEB_CELL_ID, role: "browser", port, secrets: [] }),
      );
      if (opened.cellId !== WEB_CELL_ID || opened.port !== port)
        throw new Error("keyd opened a different listener");
    } catch (error) {
      await this.deps.keyd.closeCell(WEB_CELL_ID).catch(() => false);
      this.deps.ports.release(port);
      throw new WebError(
        `The web can't be reached: the key layer did not open a connection for it (${error instanceof Error ? error.message : "unknown error"}).`,
      );
    }
    // No key is held, so keyd intercepts nothing: the web's own certificates are checked.
    const agent = new ProxyAgent({
      uri: `http://127.0.0.1:${port}`,
      token: `Basic ${Buffer.from(`web:${opened.proxyToken}`).toString("base64")}`,
    });
    this.#rest();
    return { port, agent };
  }
  #rest(): void {
    clearTimeout(this.#idle);
    this.#idle = setTimeout(() => void this.close(), this.deps.idleMs ?? IDLE_MS);
    this.#idle.unref?.();
  }
  async close(): Promise<void> {
    clearTimeout(this.#idle);
    const opening = this.#open;
    this.#open = undefined;
    const cell = await opening?.catch(() => undefined);
    if (!cell) return;
    await cell.agent.close().catch(() => {});
    await this.deps.keyd.closeCell(WEB_CELL_ID).catch(() => false);
    this.deps.ports.release(cell.port);
  }
}

// Only keyd's own listener is ever dialled, so a refused connection means it is gone, and a 407
// that it no longer knows the token; the sites themselves fail behind it.
function listenerLost(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  return cause?.code === "ECONNREFUSED" || /\(407\)/.test(String(cause?.message ?? ""));
}

// What went wrong, in words for dot: keyd's refusals and the site's own failures look alike from
// here, and keyd's audit keeps which it was. The caller's own cancellation stays as it is.
function failure(error: unknown, signal: AbortSignal, own: AbortSignal): unknown {
  if (own.aborted || error instanceof WebError) return error;
  return new WebError(
    signal.aborted
      ? "The site did not answer in time."
      : "The site could not be reached, or the network rules don't allow it.",
  );
}

// The body, up to maxBytes; what is past it is never read.
async function capped(
  reply: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ body: Buffer; truncated: boolean }> {
  const reader = reply.body?.getReader();
  if (!reader) return { body: Buffer.alloc(0), truncated: false };
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) return { body: Buffer.concat(parts, size), truncated: false };
      if (size + value.byteLength > maxBytes) {
        parts.push(Buffer.from(value.subarray(0, maxBytes - size)));
        await reader.cancel().catch(() => {});
        return { body: Buffer.concat(parts, maxBytes), truncated: true };
      }
      parts.push(Buffer.from(value));
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}
