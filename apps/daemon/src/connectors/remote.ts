import { rootCertificates } from "node:tls";
import { connectorHost, KeydOpened, type KeydRecord, type RemoteServer } from "@localdot/protocol";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import type { KeydClient } from "../keyd/client.ts";
import { connectorCellId } from "./cell.ts";
import { openConnectorListener } from "./open-listener.ts";
import { ConnectorProblem } from "./problem.ts";

export interface RemoteLinksDeps {
  keyd: Pick<KeydClient, "openCell" | "closeCell" | "secrets">;
  ports: { reserve(): number; release(port: number): void };
  fetch?: typeof undiciFetch;
}

export interface RemoteLink {
  // Requests through keyd to the connector's own host only, carrying its key's stand-in.
  readonly fetch: FetchLike;
  close(): Promise<void>;
}

// The header that carries a key, as its binding says: keyd swaps the stand-in for the key only at
// the hosts the key is bound to.
export function keyHeader(
  record: Pick<KeydRecord, "kind" | "hosts" | "header" | "format">,
  host: string,
  surrogate: string,
): { name: string; value: string } {
  if (record.kind !== "http" || !record.header)
    throw new ConnectorProblem("needs_key", "That key isn't a web key. Add the app's own key.");
  if (!(record.hosts ?? []).includes(host))
    throw new ConnectorProblem("needs_key", `That key isn't for ${host}. Add a key for this app.`);
  if (record.format === "bearer") return { name: record.header, value: `Bearer ${surrogate}` };
  if (record.format === "raw") return { name: record.header, value: surrogate };
  throw new ConnectorProblem("needs_key", "This kind of key doesn't work for apps yet.");
}

// The daemon reaches a remote connector through a keyd listener of the connector's own, the way
// every cell reaches the web: keyd checks where it goes and puts the key in at the edge, so the
// daemon only ever holds the stand-in.
export class RemoteLinks {
  constructor(private readonly deps: RemoteLinksDeps) {}

  // A keyd listener of the daemon's own for one connector, with only that connector's key.
  async #listener(cellId: string, secrets: string[]) {
    await this.deps.keyd.closeCell(cellId).catch(() => false);
    const port = this.deps.ports.reserve();
    let opened: KeydOpened;
    try {
      opened = KeydOpened.parse(
        await openConnectorListener(this.deps.keyd, { cellId, role: "connector", port, secrets }),
      );
      if (opened.cellId !== cellId || opened.port !== port)
        throw new Error("keyd opened a different listener");
    } catch (error) {
      await this.deps.keyd.closeCell(cellId).catch(() => false);
      this.deps.ports.release(port);
      throw error;
    }
    const agent = new ProxyAgent({
      uri: `http://127.0.0.1:${port}`,
      token: `Basic ${Buffer.from(`connector:${opened.proxyToken}`).toString("base64")}`,
      // keyd's own authority for the hosts it swaps keys at; the web's for the rest.
      requestTls: { ca: [...rootCertificates, opened.caCertPem] },
    });
    const close = async () => {
      await agent.close().catch(() => {});
      await this.deps.keyd.closeCell(cellId).catch(() => false);
      this.deps.ports.release(port);
    };
    return { opened, agent, close };
  }

  async open(connectorId: string, server: RemoteServer): Promise<RemoteLink> {
    const host = connectorHost(server.url);
    const secret = server.auth.kind === "none" ? undefined : server.auth.secret;
    if (server.auth.kind === "oauth" && !secret)
      throw new ConnectorProblem("needs_sign_in", "Sign in to use this app.");
    let record: KeydRecord | undefined;
    if (secret) {
      record = (await this.deps.keyd.secrets()).find((each) => each.id === secret);
      if (!record || record.reenter || record.rebound)
        throw new ConnectorProblem(
          server.auth.kind === "oauth" ? "needs_sign_in" : "needs_key",
          server.auth.kind === "oauth" ? "Sign in to use this app." : "Add the app's key.",
        );
    }
    const { opened, agent, close } = await this.#listener(
      connectorCellId(connectorId),
      secret ? [secret] : [],
    );
    let auth: { name: string; value: string } | undefined;
    try {
      if (secret && record) {
        const surrogate = opened.surrogates?.[secret];
        if (!surrogate) throw new Error("keyd did not hand over the connector's key");
        auth = keyHeader(record, host, surrogate);
      }
    } catch (error) {
      await close();
      throw error;
    }
    const send = this.deps.fetch ?? undiciFetch;
    const fetch: FetchLike = async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.protocol !== "https:" || url.hostname.toLowerCase() !== host)
        throw new Error("A connector reaches only its own address.");
      const headers = new Headers(init?.headers);
      if (auth) headers.set(auth.name, auth.value);
      const reply = await send(url, {
        ...(init as Record<string, unknown>),
        headers,
        dispatcher: agent,
        redirect: "manual",
      } as Parameters<typeof undiciFetch>[1]);
      return reply as unknown as Response;
    };
    return { fetch, close };
  }

  // The sign-in's own requests: discovery and the token exchange may reach the app's sign-in
  // service on another host, so these go anywhere on the web through keyd, with no key.
  async signIn(connectorId: string): Promise<RemoteLink> {
    const { agent, close } = await this.#listener(`${connectorCellId(connectorId)}-signin`, []);
    const send = this.deps.fetch ?? undiciFetch;
    const fetch: FetchLike = async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.protocol !== "https:") throw new Error("Sign-in reaches only https addresses.");
      const reply = await send(url, {
        ...(init as Record<string, unknown>),
        dispatcher: agent,
      } as Parameters<typeof undiciFetch>[1]);
      return reply as unknown as Response;
    };
    return { fetch, close };
  }
}
