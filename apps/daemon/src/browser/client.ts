import { createHash } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { addAbortSignal, Readable } from "node:stream";
import { finished } from "node:stream/promises";
import {
  BrowserReadRequest,
  BrowserReadResult,
  ClockResult,
  HitTestResult,
  type InputRequest,
  InputResult,
  ManualInput,
  ObserveResult,
  type Point,
  SettleRequest,
  SettleResult,
  Target,
  type TypeProgress,
  TypeRequest,
  TypeResult,
  ULID_PATTERN,
} from "@localdot/protocol";
import { keyName } from "@localdot/protocol/keys";
import { z } from "zod";
import {
  BrowserActionPermit,
  BrowserControlReply,
  BrowserControlRequest,
  BrowserManualPermit,
  type BrowserManualReply,
} from "../../../../packages/protocol/src/browser-control.ts";
import {
  BrowserDownloadBinding,
  BrowserDownloadOffer,
} from "../../../../packages/protocol/src/browser-downloads.ts";
import {
  BrowserUploadOffer,
  BrowserUploadReceipt,
  BrowserUploadRequest,
} from "../../../../packages/protocol/src/browser-uploads.ts";
import { safeDownloadName } from "../../../../packages/protocol/src/quarantine.ts";
import type { ReadyBrowser } from "../cells/browser-orchestrator.ts";

const identity = z.strictObject({
  browserCellId: z.string().regex(ULID_PATTERN),
  parentCellId: z.string().regex(ULID_PATTERN),
  instance: z.uuid(),
});
const health = identity.extend({
  ready: z.literal(true),
  holder: z.enum(["user", "agent"]),
  width: z.literal(1280),
  height: z.literal(800),
});
const tabs = z.strictObject({
  tabs: z.array(z.strictObject({ id: z.uuid(), ready: z.boolean() })).max(256),
});
const observation = z.strictObject({
  frame: ObserveResult.extend({
    width: z.literal(1280),
    height: z.literal(800),
    image: z
      .string()
      .min(1)
      .max(8 * 1024 * 1024),
  }),
  targets: z.array(Target).max(4096),
});
const progress = z.strictObject({
  kind: z.literal("progress"),
  count: z.number().int().min(1).max(4000),
  pressMono: z.number().finite().nonnegative(),
});
const mono = z.number().finite().nonnegative();
const inputReply = InputResult.extend({
  injector: z.literal("xtest"),
  armedMono: mono,
  pressMono: mono,
  releaseMono: mono.optional(),
  presses: z.array(mono).max(32),
})
  .strict()
  .refine(
    (value) =>
      value.pressMono >= value.armedMono &&
      (value.releaseMono === undefined || value.releaseMono >= value.pressMono) &&
      value.presses.every(
        (time, index) =>
          time >= value.armedMono && (index === 0 || time >= (value.presses[index - 1] ?? 0)),
      ),
  );
const typeReply = TypeResult.extend({
  injector: z.literal("xtest"),
  armedMono: mono,
  firstPressMono: mono,
  count: z.number().int().min(1).max(4000),
})
  .strict()
  .refine((value) => value.firstPressMono >= value.armedMono);
const typed = z.strictObject({ kind: z.literal("result"), result: typeReply });
const manualReply = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("input"),
    receipt: inputReply.safeExtend({ presses: z.array(mono).max(64) }),
  }),
  z.strictObject({ kind: z.literal("text"), receipt: typeReply }),
]);
const done = z.strictObject({ done: z.literal(true) });
const page = BrowserReadResult.extend({
  url: z.string().max(8192),
  title: z.string().max(2048),
  text: z.string().max(100000),
  outline: z.string().max(20000),
}).strict();
const stopped = identity.extend({ stopped: z.literal(true) });
const BODY_LIMIT = 65536;
const RESPONSE_LIMIT = 12 * 1024 * 1024;

export type BrowserLookup =
  | { kind: "focused" }
  | { kind: "hitTest"; point: Point }
  | { kind: "find"; name: string; role?: string; app?: string };

// Both the model and the task timeline show these messages.
const REFUSALS = {
  request: "The request to the web browser was not valid.",
  stale: "The web browser or the selected screen changed during the request.",
  aborted: "The web browser did not answer in time, or the request was cancelled.",
  unavailable: "The web browser is not responding.",
  reply: "The web browser sent a reply that could not be read.",
} as const;

export class BrowserClientError extends Error {
  constructor(readonly code: keyof typeof REFUSALS) {
    super(REFUSALS[code]);
    this.name = "BrowserClientError";
  }
}

export interface BrowserScope {
  readonly signal: AbortSignal;
  // The session/screen owner must still authorize the physical target and generation.
  check(): void;
}

// Reject unsupported names/control characters before the session marks an input dispatched.
export function checkManualBrowserInput(raw: unknown): void {
  const input = ManualInput.parse(raw);
  if (input.kind === "key") {
    const keys = input.combo.map(keyName);
    const modifiers = new Set(["Control_L", "Shift_L", "Alt_L", "Super_L", "ISO_Level3_Shift"]);
    if (
      new Set(keys).size !== keys.length ||
      modifiers.has(keys.at(-1) ?? "") ||
      keys.slice(0, -1).some((name) => !modifiers.has(name))
    )
      throw new BrowserClientError("request");
  } else if (input.kind === "click") {
    if (new Set(input.mods).size !== (input.mods?.length ?? 0))
      throw new BrowserClientError("request");
  } else if (input.kind === "text") {
    for (const ch of input.text) {
      const n = ch.codePointAt(0) ?? 0;
      if ((n < 32 && n !== 9 && n !== 10) || (n >= 127 && n <= 159))
        throw new BrowserClientError("request");
    }
  }
}

function parse<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch {
    throw new BrowserClientError("reply");
  }
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new BrowserClientError("aborted"));
    signal.addEventListener("abort", abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

// An authenticated local transport, not a source of session authority. Every call
// requires the current screen/session owner's check as well as the browserd permit.
export class BrowserClient {
  readonly #id: z.infer<typeof identity>;
  readonly #port: number;
  readonly #token: string;
  readonly #lifetime = new AbortController();

  constructor(endpoint: ReadyBrowser) {
    this.#id = Object.freeze(
      parse(identity, {
        browserCellId: endpoint.browserCellId,
        parentCellId: endpoint.parentCellId,
        instance: endpoint.instance,
      }),
    );
    if (
      !/^http:\/\/127\.0\.0\.1:[0-9]{4,5}$/u.test(endpoint.browserd.baseUrl) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(endpoint.browserd.token)
    )
      throw new BrowserClientError("request");
    this.#port = Number(new URL(endpoint.browserd.baseUrl).port);
    if (this.#port < 1024 || this.#port > 65535) throw new BrowserClientError("request");
    this.#token = endpoint.browserd.token;
  }

  close(): void {
    this.#lifetime.abort();
  }

  async health(scope: BrowserScope): Promise<z.infer<typeof health>> {
    const value = await this.#json("GET", "/health", undefined, scope, 3000, health, 4096);
    this.#checkScope(scope);
    this.#identity(value);
    return value;
  }

  tabs(scope: BrowserScope): Promise<z.infer<typeof tabs>> {
    return this.#json("GET", "/tabs", undefined, scope, 3000, tabs, 65536);
  }

  async armDownloads(raw: BrowserDownloadBinding, scope: BrowserScope): Promise<void> {
    const binding = this.#downloadBinding(raw);
    await this.#json(
      "POST",
      "/downloads/arm",
      { binding },
      scope,
      10000,
      z.strictObject({ armed: z.literal(true) }),
      4096,
    );
  }

  async downloads(
    raw: BrowserDownloadBinding,
    scope: BrowserScope,
  ): Promise<BrowserDownloadOffer[]> {
    const binding = this.#downloadBinding(raw);
    const reply = await this.#json(
      "POST",
      "/downloads/list",
      { binding },
      scope,
      3000,
      z.strictObject({ downloads: BrowserDownloadOffer.array().max(1) }),
      16384,
    );
    return reply.downloads.map((offer) => this.#downloadOffer(binding, offer));
  }

  async acknowledgeDownload(
    raw: BrowserDownloadBinding,
    candidate: BrowserDownloadOffer,
    scope: BrowserScope,
  ): Promise<void> {
    const binding = this.#downloadBinding(raw);
    const offer = this.#downloadOffer(binding, candidate);
    await this.#json(
      "POST",
      "/downloads/ack",
      {
        binding,
        guid: offer.guid,
        bytes: offer.bytes,
        sha256: offer.sha256,
      },
      scope,
      10000,
      z.strictObject({ acknowledged: z.literal(true) }),
      4096,
    );
  }

  readDownload(
    raw: BrowserDownloadBinding,
    candidate: BrowserDownloadOffer,
    scope: BrowserScope,
  ): Readable {
    const binding = this.#downloadBinding(raw);
    const offer = this.#downloadOffer(binding, candidate);
    this.#checkScope(scope);
    // No connection opens until quarantine has reserved capacity and reads the stream.
    // Local destruction also aborts a pending headers/body read before waiting for
    // the generator's finally; iterator.return() alone cannot interrupt that await.
    const abort = new AbortController();
    const iterator = this.#download(binding, offer, {
      signal: AbortSignal.any([scope.signal, abort.signal]),
      check: () => scope.check(),
    });
    const source = new Readable({
      highWaterMark: 65536,
      read() {
        void iterator
          .next()
          .then((next) => {
            if (!source.destroyed) source.push(next.done ? null : next.value);
          })
          .catch((error: unknown) =>
            source.destroy(error instanceof Error ? error : new BrowserClientError("unavailable")),
          );
      },
      destroy(error, done) {
        abort.abort();
        void iterator.return(undefined).then(
          () => done(error),
          (failure: unknown) =>
            done(
              error ?? (failure instanceof Error ? failure : new BrowserClientError("unavailable")),
            ),
        );
      },
    });
    return source;
  }

  async uploadChooser(
    permit: BrowserActionPermit,
    tabId: string,
    scope: BrowserScope,
  ): Promise<BrowserUploadOffer | undefined> {
    const reply = await this.#json(
      "POST",
      "/uploads/chooser",
      this.#action(permit, tabId),
      scope,
      5000,
      z.strictObject({ chooser: BrowserUploadOffer.nullable() }),
      1024,
    );
    return reply.chooser ?? undefined;
  }

  /** Source EOF must mean its approved identity/content have been revalidated. */
  async upload(
    raw: BrowserUploadRequest,
    source: Readable,
    scope: BrowserScope,
  ): Promise<BrowserUploadReceipt> {
    const sourceClosed = finished(source, { cleanup: true }).catch(() => {});
    const local = new AbortController(),
      deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 600000);
    timer.unref();
    const signal = AbortSignal.any([
      scope.signal,
      this.#lifetime.signal,
      local.signal,
      deadline.signal,
    ]);
    let pending: ReturnType<typeof httpRequest> | undefined;
    let response: IncomingMessage | undefined;
    let requestClosed: Promise<void> | undefined;
    let responseClosed: Promise<void> | undefined;
    const reply = Promise.withResolvers<IncomingMessage>();
    void reply.promise.catch(() => {});
    let committed = false;
    const check = () => {
      if (signal.aborted) throw new BrowserClientError("aborted");
      this.#checkScope(scope);
    };
    try {
      check();
      const request = parse(BrowserUploadRequest, raw);
      this.#identity(request.permit);
      const encoded = Buffer.from(JSON.stringify(request)).toString("base64url");
      if (encoded.length > 6144) throw new BrowserClientError("request");
      addAbortSignal(signal, source);
      const hashes = request.files.map(() => createHash("sha256"));
      const counts = request.files.map(() => 0);
      let index = 0;
      pending = httpRequest(
        {
          host: "127.0.0.1",
          port: this.#port,
          method: "POST",
          path: "/uploads/send",
          agent: false,
          signal,
          headers: {
            authorization: `Bearer ${this.#token}`,
            connection: "close",
            "content-type": "application/octet-stream",
            "transfer-encoding": "chunked",
            "x-localdot-upload": encoded,
          },
        },
        (incoming) => {
          response = incoming;
          responseClosed = new Promise<void>((resolve) => incoming.once("close", resolve));
          if (!committed || signal.aborted) {
            reply.reject(new BrowserClientError("reply"));
            local.abort();
            incoming.destroy();
          } else reply.resolve(incoming);
        },
      );
      const outgoing = pending;
      requestClosed = new Promise<void>((resolve) => outgoing.once("close", resolve));
      outgoing.on("error", (error) => {
        reply.reject(error);
        local.abort();
      });
      for await (const chunk of source) {
        check();
        if (!(chunk instanceof Uint8Array)) throw new BrowserClientError("request");
        let offset = 0;
        while (offset < chunk.byteLength) {
          while (index < request.files.length && counts[index] === request.files[index]?.bytes)
            index++;
          const file = request.files[index],
            hash = hashes[index],
            count = counts[index];
          if (!file || !hash || count === undefined) throw new BrowserClientError("request");
          const length = Math.min(65536, chunk.byteLength - offset, file.bytes - count);
          const bytes = Buffer.from(chunk.subarray(offset, offset + length));
          hash.update(bytes);
          counts[index] = count + length;
          check();
          await new Promise<void>((resolve, reject) =>
            outgoing.write(bytes, (error) => (error ? reject(error) : resolve())),
          );
          offset += length;
        }
      }
      check();
      for (const [index, file] of request.files.entries()) {
        if (counts[index] !== file.bytes || hashes[index]?.digest("hex") !== file.sha256)
          throw new BrowserClientError("request");
      }
      // Destruction may own outstanding source transport cleanup. Its completion
      // is part of the transfer lease, and precedes the browser's commit marker.
      source.destroy();
      await sourceClosed;
      check();
      committed = true;
      outgoing.end();
      const incoming = await reply.promise;
      check();
      if (
        incoming.statusCode !== 200 ||
        incoming.headers["content-type"] !== "application/json" ||
        incoming.headers["content-encoding"] !== undefined
      )
        throw new BrowserClientError("reply");
      let count = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) {
        check();
        count += chunk.length;
        if (count > 8192) throw new BrowserClientError("reply");
        chunks.push(chunk);
      }
      check();
      if (!incoming.complete) throw new BrowserClientError("reply");
      const receipt = parse(
        BrowserUploadReceipt,
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, count))),
      );
      if (
        receipt.chooserId !== request.chooserId ||
        receipt.destination.origin !== request.destination.origin ||
        receipt.destination.embedded !== request.destination.embedded ||
        JSON.stringify(receipt.files) !== JSON.stringify(request.files)
      )
        throw new BrowserClientError("stale");
      return receipt;
    } catch (error) {
      if (error instanceof BrowserClientError) throw error;
      throw new BrowserClientError(
        scope.signal.aborted || this.#lifetime.signal.aborted || deadline.signal.aborted
          ? "aborted"
          : "unavailable",
      );
    } finally {
      clearTimeout(timer);
      local.abort();
      source.destroy();
      pending?.destroy();
      response?.destroy();
      await sourceClosed;
      await requestClosed;
      await responseClosed;
    }
  }

  #downloadBinding(raw: BrowserDownloadBinding): BrowserDownloadBinding {
    const binding = parse(BrowserDownloadBinding, raw);
    this.#identity(binding.permit);
    return binding;
  }

  #downloadOffer(binding: BrowserDownloadBinding, raw: BrowserDownloadOffer): BrowserDownloadOffer {
    const offer = parse(BrowserDownloadOffer, raw);
    this.#identity({ ...offer.origin, instance: offer.origin.browserInstance });
    if (
      offer.origin.sessionId !== binding.sessionId ||
      safeDownloadName(offer.origin.name) !== offer.origin.name
    )
      throw new BrowserClientError("stale");
    return offer;
  }

  async *#download(
    binding: BrowserDownloadBinding,
    offer: BrowserDownloadOffer,
    scope: BrowserScope,
  ): AsyncGenerator<Uint8Array> {
    const connection = await this.#connection(
      "POST",
      "/downloads/read",
      { binding, guid: offer.guid },
      scope,
      600000,
    );
    try {
      const { response, check } = connection;
      if (
        response.headers["content-type"] !== "application/octet-stream" ||
        response.headers["content-length"] !== undefined ||
        response.headers["transfer-encoding"] !== "chunked"
      )
        throw new BrowserClientError("reply");
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of response) {
        check();
        if (!(chunk instanceof Uint8Array) || bytes + chunk.byteLength > offer.bytes)
          throw new BrowserClientError("reply");
        bytes += chunk.byteLength;
        hash.update(chunk);
        for (let offset = 0; offset < chunk.byteLength; offset += 65536) {
          check();
          yield chunk.subarray(offset, offset + 65536);
        }
      }
      check();
      if (!response.complete || bytes !== offer.bytes || hash.digest("hex") !== offer.sha256)
        throw new BrowserClientError("reply");
    } catch (error) {
      if (error instanceof BrowserClientError) throw error;
      throw new BrowserClientError(connection.signal.aborted ? "aborted" : "unavailable");
    } finally {
      await connection.close();
    }
  }

  async control(raw: BrowserControlRequest, scope: BrowserScope): Promise<BrowserControlReply> {
    const request = parse(BrowserControlRequest, raw);
    this.#identity(request);
    const reply = await this.#json(
      "PUT",
      "/control",
      request,
      scope,
      6500,
      BrowserControlReply,
      4096,
    );
    this.#checkScope(scope);
    this.#identity(reply);
    if (
      reply.revision !== request.revision ||
      reply.requestId !== request.requestId ||
      reply.holder !== request.holder ||
      (reply.holder === "agent" && !reply.selectionsCleared)
    )
      throw new BrowserClientError("stale");
    return reply;
  }

  observe(
    permit: BrowserActionPermit,
    tabId: string,
    scope: BrowserScope,
  ): Promise<z.infer<typeof observation>> {
    return this.#json("POST", "/observe", this.#action(permit, tabId), scope, 17000, observation);
  }

  async manual(
    permit: BrowserManualPermit,
    raw: ManualInput,
    scope: BrowserScope,
  ): Promise<BrowserManualReply> {
    const capability = parse(BrowserManualPermit, permit);
    this.#identity(capability);
    const input = parse(ManualInput, raw);
    checkManualBrowserInput(input);
    const result = await this.#json(
      "POST",
      "/manual",
      { permit: capability, request: input },
      scope,
      32000,
      manualReply,
      4096,
    );
    if (
      (input.kind === "text") !== (result.kind === "text") ||
      (input.kind === "text" &&
        result.kind === "text" &&
        result.receipt.count !== [...input.text].length)
    )
      throw new BrowserClientError("reply");
    return result;
  }

  lookup(
    permit: BrowserActionPermit,
    tabId: string,
    request: BrowserLookup,
    scope: BrowserScope,
  ): Promise<HitTestResult> {
    return this.#json(
      "POST",
      "/lookup",
      { ...this.#action(permit, tabId), request },
      scope,
      17000,
      HitTestResult,
      65536,
    );
  }

  clock(permit: BrowserActionPermit, tabId: string, scope: BrowserScope): Promise<ClockResult> {
    return this.#json(
      "POST",
      "/timing",
      { ...this.#action(permit, tabId), request: { kind: "clock" } },
      scope,
      17000,
      ClockResult.extend({ mono }).strict(),
      4096,
    );
  }

  settle(
    permit: BrowserActionPermit,
    tabId: string,
    request: Partial<SettleRequest>,
    scope: BrowserScope,
  ): Promise<SettleResult> {
    return this.#json(
      "POST",
      "/timing",
      {
        ...this.#action(permit, tabId),
        request: { kind: "settle", request: parse(SettleRequest.strict(), request) },
      },
      scope,
      35000,
      SettleResult,
      65536,
    );
  }

  input(
    permit: BrowserActionPermit,
    tabId: string,
    request: InputRequest,
    scope: BrowserScope,
  ): Promise<InputResult> {
    const motionMs =
      request.input.kind === "drag" || request.input.kind === "move"
        ? (request.input.durationMs ?? 0)
        : 0;
    return this.#json(
      "POST",
      "/input",
      { ...this.#action(permit, tabId), request },
      scope,
      10000 + motionMs,
      inputReply,
      65536,
    );
  }

  read(
    permit: BrowserActionPermit,
    tabId: string,
    raw: BrowserReadRequest,
    scope: BrowserScope,
  ): Promise<BrowserReadResult> {
    const request = parse(BrowserReadRequest.strict(), raw);
    return this.#json(
      "POST",
      "/read",
      { ...this.#action(permit, tabId), request },
      scope,
      17000,
      page,
      1024 * 1024,
    );
  }

  navigate(
    permit: BrowserActionPermit,
    tabId: string,
    url: string,
    scope: BrowserScope,
  ): Promise<z.infer<typeof done>> {
    if (typeof url !== "string" || !url.length || url.length > 8192)
      return Promise.reject(new BrowserClientError("request"));
    return this.#json(
      "POST",
      "/navigate",
      { ...this.#action(permit, tabId), url },
      scope,
      20000,
      done,
      4096,
    );
  }

  async stop(scope: BrowserScope): Promise<void> {
    const reply = await this.#json("POST", "/stop", this.#id, scope, 8000, stopped, 4096);
    this.#checkScope(scope);
    this.#identity(reply);
    this.close();
  }

  type(
    permit: BrowserActionPermit,
    tabId: string,
    raw: TypeRequest,
    scope: BrowserScope,
    onProgress: (value: TypeProgress) => void | Promise<void>,
  ): Promise<TypeResult> {
    const request = parse(TypeRequest, raw);
    const count = [...request.text].length;
    return this.#exchange(
      "POST",
      "/type",
      { ...this.#action(permit, tabId), request },
      scope,
      Math.min(120000, 10000 + count * 1000),
      async (response, signal, check) => {
        if (response.headers["content-type"] !== "application/x-ndjson")
          throw new BrowserClientError("reply");
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let buffered = "",
          received = 0,
          lastCount = 0,
          lastMono = -1;
        let result: TypeResult | undefined;
        for await (const chunk of response) {
          check();
          received += chunk.length;
          if (received > 512 * 1024) throw new BrowserClientError("reply");
          buffered += decoder.decode(chunk, { stream: true });
          for (;;) {
            const newline = buffered.indexOf("\n");
            if (newline < 0) break;
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            if (!line.length || line.length > 8192 || result) throw new BrowserClientError("reply");
            const event: unknown = JSON.parse(line);
            const update = progress.safeParse(event);
            if (update.success) {
              if (
                update.data.count <= lastCount ||
                update.data.count > count ||
                update.data.pressMono < lastMono
              )
                throw new BrowserClientError("reply");
              lastCount = update.data.count;
              lastMono = update.data.pressMono;
              check();
              await abortable(
                Promise.resolve().then(() => {
                  check();
                  return onProgress({ count: lastCount, pressMono: lastMono });
                }),
                signal,
              );
              check();
            } else {
              result = parse(typed, event).result;
              if (
                result.count !== count ||
                result.count !== lastCount ||
                result.firstPressMono === null ||
                result.firstPressMono > lastMono
              )
                throw new BrowserClientError("reply");
            }
          }
          if (buffered.length > 8192) throw new BrowserClientError("reply");
        }
        buffered += decoder.decode();
        check();
        if (buffered.length || !result) throw new BrowserClientError("reply");
        return result;
      },
    );
  }

  #identity(value: z.infer<typeof identity>): void {
    if (
      value.browserCellId !== this.#id.browserCellId ||
      value.parentCellId !== this.#id.parentCellId ||
      value.instance !== this.#id.instance
    )
      throw new BrowserClientError("stale");
  }

  #checkScope(scope: BrowserScope): void {
    if (scope.signal.aborted || this.#lifetime.signal.aborted)
      throw new BrowserClientError("aborted");
    try {
      scope.check();
    } catch {
      throw new BrowserClientError("stale");
    }
    if (scope.signal.aborted || this.#lifetime.signal.aborted)
      throw new BrowserClientError("aborted");
  }

  #action(raw: BrowserActionPermit, tab: string) {
    const permit = parse(BrowserActionPermit, raw);
    this.#identity(permit);
    const tabId = parse(z.uuid(), tab);
    return { permit, tabId };
  }

  #json<T>(
    method: string,
    path: string,
    body: unknown,
    scope: BrowserScope,
    ms: number,
    schema: { parse(value: unknown): T },
    max = RESPONSE_LIMIT,
  ): Promise<T> {
    return this.#exchange(method, path, body, scope, ms, async (response, _signal, check) => {
      if (response.headers["content-type"] !== "application/json")
        throw new BrowserClientError("reply");
      let length = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of response) {
        check();
        length += chunk.length;
        if (length > max) throw new BrowserClientError("reply");
        chunks.push(chunk);
      }
      check();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length));
      return parse(schema, JSON.parse(text));
    });
  }

  async #exchange<T>(
    method: string,
    path: string,
    body: unknown,
    scope: BrowserScope,
    ms: number,
    read: (response: IncomingMessage, signal: AbortSignal, check: () => void) => Promise<T>,
  ): Promise<T> {
    const connection = await this.#connection(method, path, body, scope, ms);
    try {
      const result = await read(connection.response, connection.signal, connection.check);
      connection.check();
      return result;
    } catch (error) {
      if (error instanceof BrowserClientError) throw error;
      throw new BrowserClientError(connection.signal.aborted ? "aborted" : "unavailable");
    } finally {
      await connection.close();
    }
  }

  async #connection(method: string, path: string, body: unknown, scope: BrowserScope, ms: number) {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), ms);
    const signal = AbortSignal.any([scope.signal, this.#lifetime.signal, deadline.signal]);
    let response: IncomingMessage | undefined;
    let pending: ReturnType<typeof httpRequest> | undefined;
    let responseClosed: Promise<void> | undefined;
    let requestClosed: Promise<void> | undefined;
    const close = async () => {
      clearTimeout(timer);
      response?.destroy();
      pending?.destroy();
      await Promise.all([responseClosed, requestClosed]);
    };
    const check = () => {
      if (signal.aborted) throw new BrowserClientError("aborted");
      try {
        scope.check();
      } catch {
        throw new BrowserClientError("stale");
      }
      if (signal.aborted) throw new BrowserClientError("aborted");
    };
    try {
      check();
      const payload = body === undefined ? undefined : JSON.stringify(body);
      if (payload !== undefined && Buffer.byteLength(payload) > BODY_LIMIT)
        throw new BrowserClientError("request");
      check();
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        // Fixed loopback transport bypasses environment proxy settings and never follows redirects.
        pending = httpRequest(
          {
            host: "127.0.0.1",
            port: this.#port,
            method,
            path,
            agent: false,
            signal,
            headers: {
              authorization: `Bearer ${this.#token}`,
              connection: "close",
              ...(payload
                ? {
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(payload),
                  }
                : {}),
            },
          },
          (incoming) => {
            response = incoming;
            responseClosed = new Promise<void>((done) => incoming.once("close", done));
            resolve(incoming);
          },
        );
        requestClosed = new Promise<void>((done) => pending?.once("close", done));
        pending.on("error", reject);
        pending.end(payload);
      });
      check();
      if (response.statusCode !== 200 || response.headers["content-encoding"] !== undefined)
        throw new BrowserClientError("unavailable");
      return { response, signal, check, close };
    } catch (error) {
      await close();
      if (error instanceof BrowserClientError) throw error;
      throw new BrowserClientError(signal.aborted ? "aborted" : "unavailable");
    }
  }
}
