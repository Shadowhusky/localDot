import { randomUUID } from "node:crypto";
import {
  type ApiRequestInput,
  isConnectorSecret,
  type KeydRecord,
  type KeyUsage,
} from "@localdot/protocol";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import type { KeydClient } from "./client.ts";

export const SERVICE_BYTES = 64 * 1024 * 1024;
export interface ServiceKeyDeps {
  keyd: Pick<KeydClient, "secrets" | "openCell" | "closeCell">;
  ports: { reserve(): number; release(port: number): void };
  fetch?: typeof undiciFetch;
}
export interface ServiceReply {
  status: number;
  contentType: string;
  body: Buffer;
  truncated: boolean;
}

// One bounded call, one private listener and one key. Nothing runs on a host shell and no
// credential value leaves keyd. A newly saved key is immediately usable without restarting a VM.
export class ServiceKeys {
  #active = new Set<AbortController>();
  #closed = false;
  #draining = new Set<Promise<void>>();
  #listeners = new Map<string, number>();
  constructor(private readonly deps: ServiceKeyDeps) {}
  async list(query = ""): Promise<KeydRecord[]> {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (await this.deps.keyd.secrets())
      .filter((k) => !isConnectorSecret(k.id))
      .filter((k) => {
        const haystack = JSON.stringify([
          k.id,
          k.provider,
          k.metadata,
          k.usage?.hosts,
          k.hosts,
        ]).toLowerCase();
        return words.every((word) => haystack.includes(word));
      });
  }
  async request(
    input: ApiRequestInput,
    body: Uint8Array | undefined,
    own: AbortSignal,
  ): Promise<ServiceReply> {
    own.throwIfAborted();
    if (this.#closed || this.#active.size >= 4 || this.#listeners.size >= 4)
      throw new Error("Service connections are busy. Try after the current call finishes.");
    const controller = new AbortController();
    this.#active.add(controller);
    const done = Promise.withResolvers<void>();
    this.#draining.add(done.promise);
    const signal = AbortSignal.any([own, controller.signal, AbortSignal.timeout(110_000)]);
    let port: number | undefined, agent: ProxyAgent | undefined;
    const cellId = `service-${randomUUID()}`;
    try {
      const record = (await this.list()).find((key) => key.id === input.key_id);
      if (!record || record.reenter || record.rebound)
        throw new Error("The selected key is missing or needs attention in Keys.");
      if (record.kind === "secret")
        throw new Error(
          "This general key has no API binding. Choose a saved model or service key for an API request.",
        );
      if (!record.usage)
        throw new Error("Update the localDot key layer to use saved keys with service APIs.");
      const usage = record.usage;
      const url = serviceURL(input.url, usage, input.method);
      const headers = serviceHeaders(input.headers ?? {}, usage);
      signal.throwIfAborted();
      port = this.deps.ports.reserve();
      this.#listeners.set(cellId, port);
      const opened = await this.deps.keyd.openCell({
        cellId,
        role: "service",
        port,
        secrets: [record.id],
      });
      const surrogate = opened.surrogates?.[record.id];
      if (!surrogate || opened.cellId !== cellId || opened.port !== port)
        throw new Error("The key layer did not open the requested service connection.");
      headers[usage.header] = authorization(usage, surrogate);
      if (body && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type"))
        headers["content-type"] = "application/json";
      agent = new ProxyAgent({
        uri: `http://127.0.0.1:${port}`,
        token: `Basic ${Buffer.from(`service:${opened.proxyToken}`).toString("base64")}`,
        requestTls: { ca: opened.caCertPem, servername: url.hostname },
      });
      signal.throwIfAborted();
      let reply: Awaited<ReturnType<typeof undiciFetch>>;
      try {
        reply = await (this.deps.fetch ?? undiciFetch)(url, {
          method: input.method,
          headers,
          body: body as Uint8Array<ArrayBuffer> | undefined,
          dispatcher: agent,
          redirect: "manual",
          signal,
        });
      } catch {
        own.throwIfAborted();
        throw new Error(
          "The service call did not return a verified response. A write may have completed; check its status before retrying.",
        );
      }
      if (reply.status >= 300 && reply.status < 400) {
        await reply.body?.cancel();
        throw new Error(
          "The service redirected. No key was forwarded. Check the documented endpoint before continuing.",
        );
      }
      const chunks: Buffer[] = [];
      let size = 0,
        truncated = false;
      const reader = reply.body?.getReader();
      const limit = input.output_path ? SERVICE_BYTES : 32 * 1024;
      try {
        if (reader)
          for (;;) {
            signal.throwIfAborted();
            const next = await reader.read();
            if (next.done) break;
            if (size + next.value.length > limit) {
              chunks.push(Buffer.from(next.value.subarray(0, limit - size)));
              size = limit;
              truncated = true;
              await reader.cancel();
              break;
            }
            chunks.push(Buffer.from(next.value));
            size += next.value.length;
          }
      } catch {
        own.throwIfAborted();
        throw new Error(
          "The service response was interrupted. A write may have completed; check its status before retrying.",
        );
      } finally {
        reader?.releaseLock();
      }
      return {
        status: reply.status,
        contentType: reply.headers.get("content-type") ?? "application/octet-stream",
        body: Buffer.concat(chunks, size),
        truncated,
      };
    } finally {
      controller.abort();
      try {
        await this.#finish(agent, cellId, port);
      } finally {
        this.#active.delete(controller);
        this.#draining.delete(done.promise);
        done.resolve();
      }
    }
  }
  async #finish(agent: ProxyAgent | undefined, cellId: string, port: number | undefined) {
    try {
      await agent?.destroy();
    } finally {
      if (port !== undefined)
        await this.#closeListener(cellId, port).catch(() => {
          throw new Error(
            "Service connection cleanup could not be confirmed. A write may have completed; check its status before retrying.",
          );
        });
    }
  }
  async #closeListener(cellId: string, port: number) {
    await this.deps.keyd.closeCell(cellId);
    this.#listeners.delete(cellId);
    this.deps.ports.release(port);
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#active) controller.abort();
    await Promise.all([...this.#draining]);
    await Promise.all([...this.#listeners].map(([id, port]) => this.#closeListener(id, port)));
  }
}
export function serviceURL(value: string, usage: KeyUsage, method: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !usage.hosts.includes(url.hostname)
  )
    throw new Error("The URL must use HTTPS at a host bound to this key.");
  if (usage.methods?.length && !usage.methods.includes(method))
    throw new Error("This key does not allow that HTTP method.");
  if (
    usage.paths?.length &&
    !usage.paths.some(
      (p) => url.pathname === p || url.pathname.startsWith(p.endsWith("/") ? p : `${p}/`),
    )
  )
    throw new Error("This key does not allow that API path.");
  return url;
}
export function serviceHeaders(
  input: Record<string, string>,
  usage: KeyUsage,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (
      !/^[a-zA-Z0-9-]+$/.test(name) ||
      /[\r\n\0]/.test(value) ||
      /^(authorization|proxy-.*|cookie|set-cookie|host|connection|content-length|transfer-encoding|upgrade|trailer|te)$/i.test(
        name,
      ) ||
      name.toLowerCase() === usage.header.toLowerCase()
    )
      throw new Error(
        "Authentication and transport headers are managed by localDot. Supply only ordinary API headers.",
      );
    result[name] = value;
  }
  return result;
}
function authorization(usage: KeyUsage, token: string): string {
  if (usage.format === "bearer") return `Bearer ${token}`;
  if (usage.format === "basic-user") return `Basic ${Buffer.from(`${token}:`).toString("base64")}`;
  if (usage.format === "basic-password")
    return `Basic ${Buffer.from(`:${token}`).toString("base64")}`;
  return token;
}
