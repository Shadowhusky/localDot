import { randomBytes } from "node:crypto";
import {
  type ConnectorConfig,
  connectorHost,
  connectorSecretId,
  type HttpBinding,
  type RemoteServer,
  type Sealed,
  sealSecret,
} from "@localdot/protocol";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { z } from "zod";
import type { KeydClient } from "../keyd/client.ts";
import type { ConnectorHub } from "./hub.ts";
import { ConnectorProblem } from "./problem.ts";

export const CALLBACK_PATH = "/connectors/callback";
const PENDING_MS = 10 * 60_000;
const MAX_PENDING = 8;

export interface SignInDeps {
  hub: Pick<ConnectorHub, "config" | "update" | "setClient" | "afterKeyChange">;
  keyd: Pick<KeydClient, "status" | "putSecret">;
  // keyd's way out for the sign-in's own requests (discovery, registration, the token exchange).
  fetchFor(connectorId: string): Promise<{ fetch: FetchLike; close(): Promise<void> }>;
  seal?: (
    publicKey: string,
    binding: z.infer<typeof HttpBinding>,
    value: string,
  ) => Promise<Sealed>;
  now?(): number;
}

interface Pending {
  readonly connectorId: string;
  readonly server: RemoteServer;
  readonly redirectUrl: string;
  readonly at: number;
  verifier?: string;
  client?: OAuthClientInformationMixed;
}

// Sign-in with an app (OAuth 2.1 with PKCE and, where the app offers it, registration of localDot
// as a client): the user signs in in their own browser; the access token goes straight into keyd,
// bound to the app's host, and the daemon keeps only its name. There is no refresh: when the app
// stops taking the token, the user signs in again.
export class ConnectorSignIn {
  readonly #pending = new Map<string, Pending>();
  constructor(private readonly deps: SignInDeps) {}

  #now(): number {
    return this.deps.now?.() ?? Date.now();
  }
  #sweep(): void {
    for (const [state, pending] of this.#pending)
      if (this.#now() - pending.at > PENDING_MS) this.#pending.delete(state);
  }

  #provider(state: string, pending: Pending, onUrl: (url: URL) => void): OAuthClientProvider {
    const metadata: OAuthClientMetadata = {
      client_name: "localDot",
      redirect_uris: [pending.redirectUrl],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
    const saved = this.deps.hub.config(pending.connectorId)?.client;
    return {
      get redirectUrl() {
        return pending.redirectUrl;
      },
      get clientMetadata() {
        return metadata;
      },
      state: () => state,
      clientInformation: () =>
        pending.client ??
        (saved && saved.redirectUri === pending.redirectUrl
          ? { client_id: saved.clientId }
          : undefined),
      saveClientInformation: (info) => {
        pending.client = info;
        // A public client's id is no secret; a client with a secret registers again next time.
        if (!("client_secret" in info) || !info.client_secret)
          this.deps.hub.setClient(pending.connectorId, {
            clientId: info.client_id,
            redirectUri: pending.redirectUrl,
          });
      },
      tokens: () => undefined,
      saveTokens: (tokens) => this.#keep(pending, tokens),
      redirectToAuthorization: (url) => onUrl(url),
      saveCodeVerifier: (verifier) => {
        pending.verifier = verifier;
      },
      codeVerifier: () => {
        if (!pending.verifier) throw new Error("the sign-in was not started here");
        return pending.verifier;
      },
    };
  }

  // The app's sign-in page for this connector, to open in the user's browser.
  async start(connectorId: string, origin: string): Promise<string> {
    this.#sweep();
    const config = this.deps.hub.config(connectorId);
    if (config?.server.kind !== "remote" || config.server.auth.kind !== "oauth")
      throw new ConnectorProblem("failed", "This app doesn't sign in that way.");
    if (this.#pending.size >= MAX_PENDING)
      throw new ConnectorProblem("failed", "Finish the sign-ins already open first.");
    const state = randomBytes(24).toString("base64url");
    const pending: Pending = {
      connectorId,
      server: config.server,
      redirectUrl: `${origin}${CALLBACK_PATH}`,
      at: this.#now(),
    };
    let url: URL | undefined;
    const link = await this.deps.fetchFor(connectorId);
    try {
      const result = await auth(
        this.#provider(state, pending, (at) => {
          url = at;
        }),
        { serverUrl: config.server.url, fetchFn: link.fetch },
      );
      if (result !== "REDIRECT" || !url)
        throw new ConnectorProblem("failed", "The app didn't offer a sign-in page.");
      if (url.protocol !== "https:")
        throw new ConnectorProblem("failed", "The app's sign-in page isn't secure.");
    } catch (error) {
      if (error instanceof ConnectorProblem) throw error;
      throw new ConnectorProblem("failed", "Couldn't start signing in to the app.");
    } finally {
      await link.close();
    }
    this.#pending.set(state, pending);
    return url.href;
  }

  // The app sent the user back: the code becomes a token in keyd. Returns the app's name.
  async finish(state: string, code: string): Promise<string> {
    this.#sweep();
    const pending = this.#pending.get(state);
    if (!pending) throw new ConnectorProblem("failed", "This sign-in has expired. Start again.");
    this.#pending.delete(state);
    const link = await this.deps.fetchFor(pending.connectorId);
    try {
      await auth(
        this.#provider(state, pending, () => {}),
        { serverUrl: pending.server.url, authorizationCode: code, fetchFn: link.fetch },
      );
    } catch (error) {
      if (error instanceof ConnectorProblem) throw error;
      throw new ConnectorProblem("failed", "The app didn't accept the sign-in. Try again.");
    } finally {
      await link.close();
    }
    return this.deps.hub.config(pending.connectorId)?.name ?? "the app";
  }

  async #keep(pending: Pending, tokens: OAuthTokens): Promise<void> {
    const token = tokens.access_token;
    if (!/^[\x21-\x7e]{8,8192}$/.test(token))
      throw new ConnectorProblem("failed", "The app sent a token localDot can't use.");
    const id = connectorSecretId(pending.connectorId);
    const binding = {
      id,
      kind: "http" as const,
      hosts: [connectorHost(pending.server.url)],
      header: "authorization",
      format: "bearer" as const,
    };
    const { sealKey } = await this.deps.keyd.status();
    const sealed = await (this.deps.seal ?? sealSecret)(sealKey, binding, token);
    await this.deps.keyd.putSecret(binding, sealed);
    const config = this.deps.hub.config(pending.connectorId) as ConnectorConfig | undefined;
    if (config?.server.kind === "remote")
      await this.deps.hub.update(pending.connectorId, {
        server: { ...config.server, auth: { kind: "oauth", secret: id } },
      });
    await this.deps.hub.afterKeyChange(id);
  }
}

const html = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// What the browser tab shows when the app sends the user back.
export function callbackPage(title: string, line: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${html(title)}</title><style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f5f7;color:#1d1d1f}@media (prefers-color-scheme:dark){body{background:#111215;color:#f5f5f7}}main{max-width:360px;padding:24px;text-align:center}h1{font-size:20px;font-weight:600;margin:0 0 6px}p{margin:0;opacity:.7}</style></head><body><main><h1>${html(title)}</h1><p>${html(line)}</p></main></body></html>`;
}
