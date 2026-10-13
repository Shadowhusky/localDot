import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { ManualInput, type TypeProgress, ULID_PATTERN } from "@localdot/protocol";
import { z as schema } from "zod";
import {
  BrowserActionPermit,
  BrowserControlRequest,
  BrowserManualPermit,
  BrowserManualReply,
} from "../../../../packages/protocol/src/browser-control.ts";
import {
  BrowserDownloadAck,
  BrowserDownloadOffer,
  BrowserDownloadRead,
  BrowserDownloadRequest,
} from "../../../../packages/protocol/src/browser-downloads.ts";
import {
  BrowserUploadAccess,
  BrowserUploadOffer,
  BrowserUploadReceipt,
  BrowserUploadRequest,
} from "../../../../packages/protocol/src/browser-uploads.ts";
import { DOWNLOAD_BYTES } from "../../../../packages/protocol/src/quarantine.ts";
import { WorkWindowUpdate } from "../../../../packages/protocol/src/work-window.ts";
import type { WorkWindow } from "../../../desktop/desktopd/src/work-window.ts";
import { type BrowserAccounts, isSiteName } from "./accounts.ts";
import type { BrowserControl } from "./control.ts";
import type { BrowserDownloadService } from "./download-service.ts";
import { type BrowserInput, BrowserInputError } from "./input.ts";
import type { BrowserNavigation } from "./navigation-owner.ts";
import { type BrowserObservation, BrowserObservationError } from "./observation.ts";
import type { BrowserRuntimeConfig } from "./runtime-config.ts";
import type { BrowserTargets } from "./targets.ts";
import { BROWSER_UPLOAD_TIMEOUT_MS, type BrowserUploadService } from "./upload-service.ts";

export const BROWSER_HTTP_BODY_BYTES = 65536;
export const BROWSER_HTTP_BODY_MS = 5000;
export const BROWSER_HTTP_PROGRESS_MS = 2000;
export const BROWSER_HTTP_CONNECTIONS = 64;

const identitySchema = schema.strictObject({
  browserCellId: schema.string().regex(ULID_PATTERN),
  parentCellId: schema.string().regex(ULID_PATTERN),
  instance: schema.uuid(),
});
const actionFields = {
  permit: BrowserActionPermit,
  tabId: schema.uuid(),
};
const actionSchema = schema.strictObject(actionFields);
const inputSchema = schema.strictObject({ ...actionFields, request: schema.unknown() });
const manualSchema = schema.strictObject({ permit: BrowserManualPermit, request: ManualInput });
const navigationSchema = schema.strictObject({
  ...actionFields,
  url: schema.string().min(1).max(8192),
});
const progressSchema = schema.strictObject({
  count: schema.number().int().min(1).max(4000),
  pressMono: schema.number().finite().nonnegative(),
});
const routes = new Set([
  "POST /work-window",
  "GET /health",
  "GET /tabs",
  "PUT /control",
  "POST /input",
  "POST /type",
  "POST /secret",
  "POST /manual",
  "POST /observe",
  "POST /navigate",
  "POST /lookup",
  "POST /timing",
  "POST /read",
  "POST /stop",
  "POST /downloads/arm",
  "POST /downloads/list",
  "POST /downloads/read",
  "POST /downloads/ack",
  "POST /uploads/chooser",
  "POST /uploads/send",
  "GET /accounts/cookies",
  "POST /accounts/sign-out",
]);
const signOutSchema = schema.strictObject({ site: schema.string().max(253) });

export interface BrowserHttpOptions {
  readonly workWindow?: Pick<WorkWindow, "update" | "hide" | "close">;
  readonly config: BrowserRuntimeConfig;
  readonly instance: string;
  readonly control: Pick<BrowserControl, "holder" | "set">;
  readonly targets: Pick<BrowserTargets, "tabs">;
  readonly input: Pick<BrowserInput, "inject" | "type"> &
    Partial<Pick<BrowserInput, "timing" | "manual" | "secret">>;
  readonly observation: Pick<BrowserObservation, "observe"> &
    Partial<Pick<BrowserObservation, "lookup" | "read">>;
  readonly navigation?: Pick<BrowserNavigation, "navigate">;
  readonly downloads?: Pick<BrowserDownloadService, "arm" | "list" | "read" | "acknowledge">;
  readonly uploads?: Pick<BrowserUploadService, "chooser" | "upload">;
  readonly accounts?: Pick<BrowserAccounts, "domains" | "signOut">;
  ready(): boolean;
  fence(): void;
  stop(): Promise<void>;
  retirement(): Promise<void> | undefined;
}

class HttpRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code:
      | "authentication"
      | "request"
      | "busy"
      | "unavailable"
      | "refused"
      | "login-form"
      | "protected-input",
  ) {
    super("Browser service request refused");
  }
}

function header(request: IncomingMessage, name: string): string | undefined {
  const values: string[] = [];
  for (let offset = 0; offset < request.rawHeaders.length; offset += 2) {
    if (request.rawHeaders[offset]?.toLowerCase() === name)
      values.push(request.rawHeaders[offset + 1] ?? "");
  }
  if (values.length > 1) throw new HttpRefusal(400, "request");
  return values[0];
}

function jsonBody(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  if (
    header(request, "content-type") !== "application/json" ||
    header(request, "content-encoding") !== undefined
  )
    throw new HttpRefusal(400, "request");
  const contentLength = header(request, "content-length");
  if (
    contentLength !== undefined &&
    (!/^[0-9]{1,6}$/u.test(contentLength) || Number(contentLength) > BROWSER_HTTP_BODY_BYTES)
  )
    throw new HttpRefusal(413, "request");
  return new Promise((resolve, reject) => {
    let length = 0;
    let finished = false;
    const chunks: Buffer[] = [];
    const cleanup = () => {
      clearTimeout(timeout);
      request.off("data", data);
      request.off("end", end);
      request.off("error", failed);
      signal.removeEventListener("abort", failed);
      chunks.length = 0;
    };
    const refuse = (status: number) => {
      if (finished) return;
      finished = true;
      request.pause();
      cleanup();
      reject(new HttpRefusal(status, "request"));
    };
    const failed = () => refuse(400);
    const data = (chunk: Buffer) => {
      length += chunk.length;
      if (length > BROWSER_HTTP_BODY_BYTES) return refuse(413);
      chunks.push(chunk);
    };
    const end = () => {
      if (finished) return;
      finished = true;
      try {
        const value: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length)),
        );
        resolve(value);
      } catch {
        reject(new HttpRefusal(400, "request"));
      } finally {
        cleanup();
      }
    };
    const timeout = setTimeout(() => refuse(408), BROWSER_HTTP_BODY_MS);
    request.on("data", data);
    request.once("end", end);
    request.once("error", failed);
    signal.addEventListener("abort", failed, { once: true });
    if (signal.aborted) failed();
  });
}

function send(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

function writeProgress(
  response: ServerResponse,
  progress: TypeProgress,
  signal: AbortSignal,
): Promise<void> {
  const value = progressSchema.parse({ count: progress.count, pressMono: progress.pressMono });
  if (!response.headersSent) response.setHeader("content-type", "application/x-ndjson");
  return writeChunk(response, `${JSON.stringify({ kind: "progress", ...value })}\n`, signal);
}

function writeChunk(
  response: ServerResponse,
  bytes: string | Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (response.destroyed || response.writableEnded) throw new HttpRefusal(409, "refused");
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (failed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      response.off("close", cancelled);
      response.off("error", cancelled);
      signal.removeEventListener("abort", cancelled);
      if (failed) reject(new HttpRefusal(409, "refused"));
      else resolve();
    };
    const cancelled = () => finish(true);
    const timeout = setTimeout(cancelled, BROWSER_HTTP_PROGRESS_MS);
    response.once("close", cancelled);
    response.once("error", cancelled);
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) return cancelled();
    response.write(bytes, (error) => finish(Boolean(error)));
  });
}

export class BrowserHttp {
  readonly server;
  readonly #options: Readonly<BrowserHttpOptions>;
  readonly #token: Buffer;
  readonly #identity: schema.infer<typeof identitySchema>;
  readonly #lifetime = new AbortController();
  readonly #sockets = new Set<Socket>();
  #active = false;
  #stopping?: Promise<void>;

  constructor(options: BrowserHttpOptions) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(options.config.serviceToken))
      throw new HttpRefusal(400, "request");
    this.#identity = Object.freeze(
      identitySchema.parse({
        browserCellId: options.config.browserCellId,
        parentCellId: options.config.parentCellId,
        instance: options.instance,
      }),
    );
    if (this.#identity.browserCellId === this.#identity.parentCellId)
      throw new HttpRefusal(400, "request");
    this.#options = Object.freeze({ ...options });
    this.#token = Buffer.from(`Bearer ${options.config.serviceToken}`);
    this.server = createServer(
      {
        maxHeaderSize: 8192,
        headersTimeout: 5000,
        // JSON routes retain their explicit five-second body deadline. Binary
        // uploads have their own bounded lifetime and need time for large files.
        requestTimeout: BROWSER_UPLOAD_TIMEOUT_MS,
        connectionsCheckingInterval: 1000,
      },
      (request, response) => {
        void this.#handle(request, response);
      },
    );
    this.server.keepAliveTimeout = 1000;
    this.server.maxRequestsPerSocket = 16;
    this.server.on("connection", (socket) => {
      if (this.#sockets.size >= BROWSER_HTTP_CONNECTIONS) return socket.destroy();
      this.#sockets.add(socket);
      socket.once("close", () => this.#sockets.delete(socket));
      socket.on("error", () => {});
    });
    this.server.on("checkContinue", (_request, response) => {
      response.writeHead(417, { connection: "close" });
      response.end();
    });
    this.server.on("upgrade", (_request, socket) => socket.destroy());
    this.server.on("clientError", (_error, socket) => socket.destroy());
  }

  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    const completion = Promise.withResolvers<void>();
    this.#stopping = completion.promise;
    this.#lifetime.abort();
    let fenceFailed = false;
    try {
      this.#options.fence();
    } catch {
      fenceFailed = true;
    }
    try {
      void this.#options.stop().then(
        () => {
          if (fenceFailed) completion.reject(new HttpRefusal(503, "unavailable"));
          else completion.resolve();
        },
        () => completion.reject(new HttpRefusal(503, "unavailable")),
      );
    } catch {
      completion.reject(new HttpRefusal(503, "unavailable"));
    }
    return this.#stopping;
  }

  async close(): Promise<void> {
    this.#options.workWindow?.close();
    try {
      await this.stop();
    } finally {
      this.server.closeAllConnections();
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
      this.#token.fill(0);
    }
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const disconnected = new AbortController();
    const cancel = () => disconnected.abort();
    request.once("aborted", cancel);
    request.on("error", cancel);
    response.once("close", cancel);
    response.on("error", cancel);
    const signal = AbortSignal.any([disconnected.signal, this.#lifetime.signal]);
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("connection", "close");
    let ownsSlot = false;
    let downloadStream = false;
    const route = `${request.method} ${request.url}`;
    try {
      const supplied = Buffer.from(header(request, "authorization") ?? "");
      if (supplied.length !== this.#token.length || !timingSafeEqual(supplied, this.#token))
        throw new HttpRefusal(401, "authentication");
      if (!routes.has(route)) throw new HttpRefusal(404, "request");
      if (header(request, "origin") !== undefined) throw new HttpRefusal(400, "request");
      if (route.startsWith("GET ")) {
        if (header(request, "transfer-encoding") || Number(header(request, "content-length") ?? 0))
          throw new HttpRefusal(400, "request");
        if (route === "GET /health") {
          send(response, 200, {
            ...this.#identity,
            ready:
              !this.#lifetime.signal.aborted &&
              !this.#options.retirement() &&
              this.#options.ready(),
            holder: this.#options.control.holder,
            width: 1280,
            height: 800,
          });
          return;
        }
        this.#available(signal);
        if (route === "GET /accounts/cookies") {
          if (!this.#options.accounts) throw new HttpRefusal(503, "unavailable");
          const domains = await this.#options.accounts.domains();
          this.#available(signal);
          send(response, 200, { domains });
          return;
        }
        send(response, 200, {
          tabs: this.#options.targets.tabs().map(({ id, ready }) => ({ id, ready })),
        });
        return;
      }
      if (route === "POST /uploads/send") {
        this.#available(signal);
        if (!this.#options.uploads) throw new HttpRefusal(503, "unavailable");
        // Chunked EOF is the sender's final source-validation commit. A declared
        // Content-Length could end the stream before that validation completes.
        if (
          header(request, "content-type") !== "application/octet-stream" ||
          header(request, "content-length") !== undefined ||
          header(request, "content-encoding") !== undefined ||
          header(request, "transfer-encoding") !== "chunked"
        )
          throw new HttpRefusal(400, "request");
        const encoded = header(request, "x-localdot-upload");
        if (!encoded || encoded.length > 6144 || !/^[A-Za-z0-9_-]+$/u.test(encoded))
          throw new HttpRefusal(400, "request");
        let value: unknown;
        try {
          const bytes = Buffer.from(encoded, "base64url");
          if (bytes.toString("base64url") !== encoded) throw new Error("noncanonical header");
          value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch {
          throw new HttpRefusal(400, "request");
        }
        const parsed = BrowserUploadRequest.safeParse(value);
        if (!parsed.success) throw new HttpRefusal(400, "request");
        const receipt = await this.#options.uploads.upload(parsed.data, request, signal);
        this.#available(signal);
        send(response, 200, BrowserUploadReceipt.parse(receipt));
        return;
      }
      const body = await jsonBody(request, disconnected.signal);
      if (route === "POST /work-window") {
        this.#available(signal);
        const update = WorkWindowUpdate.safeParse(body);
        if (!update.success) throw new HttpRefusal(400, "request");
        if (!this.#options.workWindow) throw new HttpRefusal(503, "unavailable");
        if (update.data.visible && this.#options.control.holder !== "agent")
          throw new HttpRefusal(409, "refused");
        await this.#options.workWindow.update(update.data);
        send(response, 200, { ok: true });
        return;
      }
      // Metadata and download collection do not touch the screen. Keep the activity window
      // stable through those calls, but clear it before any visual action or control handoff.
      if (!route.startsWith("POST /downloads/") && route !== "POST /timing")
        await this.#options.workWindow?.hide();
      if (route === "POST /stop") {
        const identity = identitySchema.safeParse(body);
        if (
          !identity.success ||
          identity.data.browserCellId !== this.#identity.browserCellId ||
          identity.data.parentCellId !== this.#identity.parentCellId ||
          identity.data.instance !== this.#identity.instance
        )
          throw new HttpRefusal(409, "refused");
        await this.stop();
        send(response, 200, { stopped: true, ...this.#identity });
        return;
      }
      this.#available(signal);
      if (route === "POST /accounts/sign-out") {
        const parsed = signOutSchema.safeParse(body);
        if (!parsed.success || !isSiteName(parsed.data.site)) throw new HttpRefusal(400, "request");
        if (!this.#options.accounts) throw new HttpRefusal(503, "unavailable");
        const result = await this.#options.accounts.signOut(parsed.data.site);
        this.#available(signal);
        send(response, 200, result);
        return;
      }
      if (route === "POST /uploads/chooser") {
        if (!this.#options.uploads) throw new HttpRefusal(503, "unavailable");
        const access = BrowserUploadAccess.safeParse(body);
        if (!access.success) throw new HttpRefusal(400, "request");
        const chooser = await this.#options.uploads.chooser(access.data, signal);
        this.#available(signal);
        send(response, 200, { chooser: chooser ? BrowserUploadOffer.parse(chooser) : null });
        return;
      }
      if (route === "PUT /control") {
        const parsed = BrowserControlRequest.safeParse(body);
        if (!parsed.success) throw new HttpRefusal(400, "request");
        const reply = await this.#options.control.set(parsed.data, signal);
        this.#available(signal);
        send(response, 200, reply);
        return;
      }
      if (route.startsWith("POST /downloads/")) {
        if (!this.#options.downloads) throw new HttpRefusal(503, "unavailable");
        const parsed = (
          route === "POST /downloads/read"
            ? BrowserDownloadRead
            : route === "POST /downloads/ack"
              ? BrowserDownloadAck
              : BrowserDownloadRequest
        ).safeParse(body);
        if (!parsed.success) throw new HttpRefusal(400, "request");
        const downloads = this.#options.downloads;
        if (route === "POST /downloads/arm") {
          await downloads.arm(parsed.data.binding, signal);
          this.#available(signal);
          send(response, 200, { armed: true });
        } else if (route === "POST /downloads/list") {
          const offers = BrowserDownloadOffer.array()
            .max(1)
            .parse(downloads.list(parsed.data.binding, signal));
          this.#available(signal);
          send(response, 200, { downloads: offers });
        } else if (route === "POST /downloads/ack") {
          const ack = BrowserDownloadAck.parse(parsed.data);
          await downloads.acknowledge(
            ack.binding,
            ack.guid,
            { bytes: ack.bytes, sha256: ack.sha256 },
            signal,
          );
          this.#available(signal);
          send(response, 200, { acknowledged: true });
        } else {
          const read = BrowserDownloadRead.parse(parsed.data);
          downloadStream = true;
          response.setHeader("content-type", "application/octet-stream");
          response.setHeader("transfer-encoding", "chunked");
          let bytes = 0;
          for await (const chunk of downloads.read(read.binding, read.guid, signal)) {
            this.#available(signal);
            bytes += chunk.byteLength;
            if (
              !(chunk instanceof Uint8Array) ||
              chunk.byteLength > 65536 ||
              bytes > DOWNLOAD_BYTES
            )
              throw new HttpRefusal(409, "refused");
            await writeChunk(response, chunk, signal);
          }
          this.#available(signal);
          // Chunked EOF comes only after the reader's final digest/identity/authority checks.
          response.end();
        }
        return;
      }
      if (route === "POST /manual") {
        const parsed = manualSchema.safeParse(body);
        if (!parsed.success) throw new HttpRefusal(400, "request");
        if (this.#active) throw new HttpRefusal(409, "busy");
        if (!this.#options.input.manual) throw new HttpRefusal(503, "unavailable");
        this.#active = true;
        ownsSlot = true;
        const reply = await this.#options.input.manual(
          parsed.data.permit,
          parsed.data.request,
          signal,
        );
        this.#available(signal);
        send(response, 200, BrowserManualReply.parse(reply));
        return;
      }
      const parsed = (
        route === "POST /observe"
          ? actionSchema
          : route === "POST /navigate"
            ? navigationSchema
            : inputSchema
      ).safeParse(body);
      if (!parsed.success) throw new HttpRefusal(400, "request");
      if (this.#active) throw new HttpRefusal(409, "busy");
      this.#active = true;
      ownsSlot = true;
      const { permit, tabId } = parsed.data;
      let result: unknown;
      if (route === "POST /observe")
        result = await this.#options.observation.observe(permit, tabId, signal);
      else if (route === "POST /navigate") {
        if (!this.#options.navigation) throw new HttpRefusal(503, "unavailable");
        const action = navigationSchema.parse(parsed.data);
        result = await this.#options.navigation.navigate(permit, tabId, action.url, signal);
      } else {
        const action = inputSchema.parse(parsed.data);
        if (route === "POST /read") {
          if (!this.#options.observation.read) throw new HttpRefusal(503, "unavailable");
          result = await this.#options.observation.read(permit, tabId, action.request, signal);
        } else if (route === "POST /lookup") {
          if (!this.#options.observation.lookup) throw new HttpRefusal(503, "unavailable");
          result = await this.#options.observation.lookup(permit, tabId, action.request, signal);
        } else if (route === "POST /timing") {
          if (!this.#options.input.timing) throw new HttpRefusal(503, "unavailable");
          result = await this.#options.input.timing(permit, tabId, action.request, signal);
        } else if (route === "POST /secret") {
          if (!this.#options.input.secret) throw new HttpRefusal(503, "unavailable");
          result = await this.#options.input.secret(permit, tabId, action.request, signal);
        } else if (route === "POST /input")
          result = await this.#options.input.inject(permit, tabId, action.request, signal);
        else
          result = await this.#options.input.type(
            permit,
            tabId,
            action.request,
            signal,
            (progress) => writeProgress(response, progress, signal),
          );
      }
      this.#available(signal);
      if (route === "POST /type") {
        if (!response.headersSent) response.setHeader("content-type", "application/x-ndjson");
        response.end(`${JSON.stringify({ kind: "result", result })}\n`);
      } else send(response, 200, result);
    } catch (error) {
      try {
        await this.#options.retirement();
      } catch {
        response.destroy();
        return;
      }
      const refusal =
        error instanceof HttpRefusal
          ? error
          : error instanceof BrowserObservationError && error.reason === "secret"
            ? new HttpRefusal(423, "protected-input")
            : route === "POST /secret" &&
                error instanceof BrowserInputError &&
                error.reason === "login-form"
              ? new HttpRefusal(422, "login-form")
              : new HttpRefusal(409, "refused");
      if (response.headersSent) {
        if (downloadStream) {
          response.destroy();
          return;
        }
        if (!response.destroyed && !response.writableEnded)
          response.end(`${JSON.stringify({ kind: "error", code: refusal.code })}\n`);
      } else send(response, refusal.status, { error: refusal.code });
    } finally {
      if (ownsSlot) this.#active = false;
      request.off("aborted", cancel);
      response.off("close", cancel);
    }
  }

  #available(signal: AbortSignal): void {
    if (signal.aborted || this.#stopping || this.#options.retirement() || !this.#options.ready())
      throw new HttpRefusal(503, "unavailable");
  }
}
