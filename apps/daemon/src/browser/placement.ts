import { request as httpRequest, type IncomingMessage } from "node:http";
import {
  PlacementCommand,
  type PlacementRequest,
  PlacementResult,
} from "../../../../packages/protocol/src/quarantine.ts";
import type { DesktopdEndpoint } from "../cells/types.ts";
import type { PlaceDownload } from "./quarantine.ts";

export class PlacementTransportError extends Error {
  constructor(
    readonly code: "changed" | "aborted" | "unavailable" | "refused" | "receipt" | "source",
  ) {
    super(`Download transport refused: ${code}`);
  }
}

// Endpoint lookup is supplied only by the parent-cell orchestrator. No model/browser URL or
// filesystem path is accepted. A new connection belongs to this transfer until its close event.
export function desktopPlacement(
  lookup: (parentCellId: string) => DesktopdEndpoint | undefined,
  timeoutMs = 10 * 60 * 1000,
): PlaceDownload {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60 * 1000)
    throw new RangeError("invalid placement timeout");
  return async (request, chunks, scope, options) => {
    scope.check();
    const command = PlacementCommand.parse({ ...request, reconcileOnly: options.reconcileOnly });
    const found = lookup(command.parentCellId);
    if (!found) throw new PlacementTransportError("changed");
    const endpoint = { ...found };
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(endpoint.token))
      throw new PlacementTransportError("unavailable");
    const url = new URL(endpoint.baseUrl);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new PlacementTransportError("unavailable");
    const stopped = new AbortController();
    const signal = AbortSignal.any([scope.signal, stopped.signal]);
    const timer = setTimeout(() => stopped.abort(), timeoutMs);
    timer.unref();
    const check = () => {
      if (signal.aborted) throw new PlacementTransportError("aborted");
      scope.check();
      const current = lookup(command.parentCellId);
      if (current?.baseUrl !== endpoint.baseUrl || current.token !== endpoint.token)
        throw new PlacementTransportError("changed");
    };
    const arrived = Promise.withResolvers<IncomingMessage>();
    const closed = Promise.withResolvers<void>();
    const interrupted = Promise.withResolvers<never>();
    void arrived.promise.catch(() => undefined);
    void interrupted.promise.catch(() => undefined);
    let response: IncomingMessage | undefined;
    let iterator: AsyncIterator<Uint8Array> | undefined;
    let pumping: Promise<void> | undefined;
    let inputComplete = options.reconcileOnly;
    let sent = 0;
    const pending = httpRequest(
      new URL("/downloads/place", url),
      {
        method: "POST",
        agent: false,
        headers: {
          authorization: `Bearer ${endpoint.token}`,
          "content-type": "application/octet-stream",
          // Fresh transfers deliberately use chunked EOF. Content-Length would let the
          // recipient commit as soon as the last bytes arrived, before our source iterator's
          // final inode/authority checks. end() below is the host's final commit admission.
          ...(options.reconcileOnly ? { "content-length": 0 } : {}),
          "x-localdot-placement": Buffer.from(JSON.stringify(command)).toString("base64url"),
          connection: "close",
        },
      },
      (incoming) => {
        response = incoming;
        arrived.resolve(incoming);
      },
    );
    pending.on("close", () => closed.resolve());
    pending.on("error", (error) => arrived.reject(error));
    const abort = () => {
      interrupted.reject(new PlacementTransportError("aborted"));
      response?.destroy();
      pending.destroy(new PlacementTransportError("aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const write = (bytes: Uint8Array) =>
      new Promise<void>((resolve, reject) => {
        pending.write(bytes, (error) => (error ? reject(error) : resolve()));
      });
    try {
      check();
      if (options.reconcileOnly) pending.end();
      else {
        iterator = chunks[Symbol.asyncIterator]();
        pumping = (async () => {
          while (iterator) {
            check();
            const next = await iterator.next();
            check();
            if (next.done) break;
            if (!(next.value instanceof Uint8Array) || sent + next.value.byteLength > command.bytes)
              throw new PlacementTransportError("source");
            sent += next.value.byteLength;
            for (let start = 0; start < next.value.byteLength; start += 64 * 1024) {
              check();
              await write(next.value.subarray(start, start + 64 * 1024));
            }
          }
          if (sent !== command.bytes) throw new PlacementTransportError("source");
          check();
          inputComplete = true;
          pending.end();
        })();
        void pumping.catch(() => undefined);
      }
      const receiving = (async () => {
        const incoming = await arrived.promise;
        check();
        if (incoming.statusCode !== 200) throw new PlacementTransportError("refused");
        if (
          incoming.headers["content-encoding"] !== undefined ||
          !/^application\/json(?:;\s*charset=utf-8)?$/i.test(incoming.headers["content-type"] ?? "")
        )
          throw new PlacementTransportError("receipt");
        const parts: Buffer[] = [];
        let count = 0;
        for await (const value of incoming) {
          check();
          count += value.length;
          if (count > 8192) throw new PlacementTransportError("receipt");
          parts.push(value);
        }
        check();
        if (!incoming.complete || !inputComplete) throw new PlacementTransportError("receipt");
        let receipt: PlacementResult;
        try {
          receipt = PlacementResult.parse(
            JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts, count)),
            ),
          );
        } catch {
          throw new PlacementTransportError("receipt");
        }
        for (const key of Object.keys(request) as (keyof PlacementRequest)[])
          if (receipt[key] !== request[key]) throw new PlacementTransportError("receipt");
        return receipt;
      })();
      void receiving.catch(() => undefined);
      const [receipt] = await Promise.race([
        Promise.all([receiving, pumping]),
        interrupted.promise,
      ]);
      check();
      return receipt;
    } catch (error) {
      if (error instanceof PlacementTransportError) throw error;
      throw new PlacementTransportError(signal.aborted ? "aborted" : "unavailable");
    } finally {
      clearTimeout(timer);
      stopped.abort();
      response?.destroy();
      pending.destroy();
      // Source next() may still own a file read. Its scope checks bound each block; retain
      // the transfer lease until that read and iterator cleanup actually finish.
      await pumping?.catch(() => undefined);
      try {
        await iterator?.return?.();
      } finally {
        await closed.promise;
        signal.removeEventListener("abort", abort);
      }
    }
  };
}
