import { randomBytes } from "node:crypto";
import {
  CLIENT_METADATA_URL,
  CONNECTOR_CALLBACK_PATH,
  connectorHost,
  connectorSecretId,
  type HttpBinding,
  KEYD_VAULT_LOCKED,
  type KeydOAuthGrant,
  type RemoteServer,
} from "@localdot/protocol";
import {
  discoverOAuthServerInfo,
  extractWWWAuthenticateParams,
  registerClient,
  selectClientAuthMethod,
  selectResourceURL,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { z } from "zod";
import { type KeydClient, KeydError } from "../keyd/client.ts";
import type { ConnectorHub } from "./hub.ts";
import { ConnectorProblem } from "./problem.ts";

export const CALLBACK_PATH = CONNECTOR_CALLBACK_PATH;
const PENDING_MS = 10 * 60_000;
const MAX_PENDING = 8;
const PROBE_MS = 10_000;

export interface SignInDeps {
  hub: Pick<
    ConnectorHub,
    "config" | "update" | "setClient" | "afterKeyChange" | "refresh" | "setSignIn" | "signInEnded"
  >;
  keyd: Pick<KeydClient, "status" | "connectOAuth">;
  // keyd's way out for the sign-in's own requests (discovery and registration). It holds the app's
  // key if it has one, because keyd lets nothing else reach a host a key is bound to.
  fetchFor(
    connectorId: string,
    secret?: string,
  ): Promise<{ fetch: FetchLike; close(): Promise<void> }>;
  // Opens a page in this computer's own browser; false if it has none.
  open(url: string): Promise<boolean>;
  now?(): number;
}

interface Pending {
  readonly connectorId: string;
  readonly server: RemoteServer;
  readonly redirectUrl: string;
  readonly at: number;
  readonly verifier: string;
  readonly issuer: string;
  readonly issuerSaid: boolean;
  readonly client: OAuthClientInformationMixed;
  readonly authMethod: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint?: string;
  readonly resource?: string;
}

export interface SignInStart {
  // The page opened in this computer's browser; if it couldn't be, its address, for a browser on
  // this computer only.
  readonly opened: boolean;
  readonly url?: string;
  readonly expiresAt: number;
}

// What a sign-in's opening exchange leaves behind: the app's own say on what to ask for.
interface Challenge {
  readonly resourceMetadataUrl?: URL;
  readonly scope?: string;
}

// An unsigned request to the app, whose refusal says where its sign-in is and what to ask for. An
// app that says nothing is found at its usual address.
async function challengeOf(url: string, fetchFn: FetchLike): Promise<Challenge> {
  try {
    const reply = await fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "localdot", version: "1.0.0" },
        },
      }),
      signal: AbortSignal.timeout(PROBE_MS),
    });
    await reply.body?.cancel().catch(() => {});
    if (reply.status !== 401) return {};
    const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(reply);
    return {
      ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
      ...(scope ? { scope } : {}),
    };
  } catch {
    return {};
  }
}

// The app's scope for this sign-in, with offline access where the service names it: a refresh token
// depends on it there, and a service that doesn't name it refuses it.
function scopeOf(
  challenge: Challenge,
  scopes: readonly string[] | undefined,
  metadata: AuthorizationServerMetadata,
): string | undefined {
  const asked = (challenge.scope ?? scopes?.join(" ") ?? "").split(/\s+/).filter(Boolean);
  if (metadata.scopes_supported?.includes("offline_access") && !asked.includes("offline_access"))
    asked.push("offline_access");
  return asked.length ? asked.join(" ") : undefined;
}

// One-click sign-in with an app: OAuth with PKCE, with no client registered in advance. The page
// opens in this computer's browser and comes back to this daemon on loopback, so the code never
// crosses another device. keyd redeems the code itself and keeps both tokens; the daemon only ever
// names the secret. See keyd/internal/oauth for how the connection then stays up.
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
  #drop(connectorId: string): void {
    for (const [state, pending] of this.#pending)
      if (pending.connectorId === connectorId) this.#pending.delete(state);
  }

  // Who localDot is to this service: its public document where the service reads one, else a
  // registration of its own, kept for next time unless it came with a secret.
  async #client(
    connectorId: string,
    authorizationServerUrl: string | URL,
    metadata: AuthorizationServerMetadata,
    redirectUrl: string,
    scope: string | undefined,
    fetchFn: FetchLike,
  ): Promise<OAuthClientInformationMixed> {
    if (metadata.client_id_metadata_document_supported === true)
      return { client_id: CLIENT_METADATA_URL };
    const saved = this.deps.hub.config(connectorId)?.client;
    if (saved && saved.redirectUri === redirectUrl && saved.issuer === metadata.issuer)
      return { client_id: saved.clientId };
    if (!metadata.registration_endpoint)
      throw new ConnectorProblem(
        "failed",
        "This app only signs in with apps registered with it, so localDot can't connect to it yet.",
      );
    const clientMetadata = {
      client_name: "localDot",
      client_uri: "https://localdot.dev",
      application_type: "native",
      redirect_uris: [redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    } as OAuthClientMetadata;
    const client = await registerClient(authorizationServerUrl, {
      metadata,
      clientMetadata,
      ...(scope ? { scope } : {}),
      fetchFn,
    }).catch(() => {
      throw new ConnectorProblem(
        "failed",
        "This app didn't let localDot register with it, so localDot can't connect to it yet.",
      );
    });
    if (!client.client_secret)
      this.deps.hub.setClient(connectorId, {
        clientId: client.client_id,
        redirectUri: redirectUrl,
        issuer: metadata.issuer,
      });
    return client;
  }

  // Opens the app's sign-in page in this computer's browser. A sign-in already open for the app is
  // replaced. `remote` says it was started from another device, which can only wait for it.
  async start(connectorId: string, origin: string, remote: boolean): Promise<SignInStart> {
    this.#sweep();
    const config = this.deps.hub.config(connectorId);
    if (config?.server.kind !== "remote" || config.server.auth.kind !== "oauth")
      throw new ConnectorProblem("failed", "This app doesn't sign in that way.");
    const keydDown = () => {
      throw new ConnectorProblem("failed", "localDot's key service didn't answer. Try again.");
    };
    if (!(await this.deps.keyd.status().catch(keydDown)).oauth)
      throw new ConnectorProblem(
        "failed",
        "localDot's key service needs an update before it can connect apps. Update localDot and try again.",
      );
    this.#drop(connectorId);
    this.deps.hub.signInEnded(connectorId);
    if (this.#pending.size >= MAX_PENDING)
      throw new ConnectorProblem("failed", "Finish the sign-ins already open first.");
    const { server } = config;
    const state = randomBytes(24).toString("base64url");
    const redirectUrl = `${origin}${CALLBACK_PATH}`;
    const link = await this.deps
      .fetchFor(connectorId, server.auth.kind === "oauth" ? server.auth.secret : undefined)
      .catch(keydDown);
    let page: URL;
    let pending: Pending;
    try {
      const challenge = await challengeOf(server.url, link.fetch);
      const info = await discoverOAuthServerInfo(server.url, {
        ...(challenge.resourceMetadataUrl
          ? { resourceMetadataUrl: challenge.resourceMetadataUrl }
          : {}),
        fetchFn: link.fetch,
      });
      const metadata = info.authorizationServerMetadata;
      if (!metadata?.code_challenge_methods_supported?.includes("S256"))
        throw new ConnectorProblem("failed", "This app's sign-in isn't one localDot can use.");
      // Fields the SDK passes through without naming on every kind of metadata.
      const loose = metadata as {
        revocation_endpoint?: string;
        authorization_response_iss_parameter_supported?: boolean;
      };
      const scope = scopeOf(challenge, info.resourceMetadata?.scopes_supported, metadata);
      const client = await this.#client(
        connectorId,
        info.authorizationServerUrl,
        metadata,
        redirectUrl,
        scope,
        link.fetch,
      );
      // The resource goes out as the app wrote it: a parsed URL would add a slash some services
      // refuse (as the SDK's own flow does).
      const allowed = await selectResourceURL(server.url, {} as never, info.resourceMetadata);
      const resource = allowed && info.resourceMetadata?.resource;
      const started = await startAuthorization(info.authorizationServerUrl, {
        metadata,
        clientInformation: client,
        redirectUrl,
        state,
        ...(scope ? { scope } : {}),
        ...(resource ? { resource } : {}),
      });
      page = started.authorizationUrl;
      if (page.protocol !== "https:")
        throw new ConnectorProblem("failed", "The app's sign-in page isn't secure.");
      pending = {
        connectorId,
        server,
        redirectUrl,
        at: this.#now(),
        verifier: started.codeVerifier,
        issuer: metadata.issuer,
        issuerSaid: loose.authorization_response_iss_parameter_supported === true,
        client,
        authMethod: selectClientAuthMethod(
          client,
          metadata.token_endpoint_auth_methods_supported ?? [],
        ),
        tokenEndpoint: metadata.token_endpoint,
        ...(loose.revocation_endpoint ? { revocationEndpoint: loose.revocation_endpoint } : {}),
        ...(resource ? { resource } : {}),
      };
    } catch (error) {
      if (error instanceof ConnectorProblem) throw error;
      throw new ConnectorProblem("failed", "Couldn't start signing in to the app.");
    } finally {
      await link.close();
    }
    const opened = await this.deps.open(page.href);
    if (!opened && remote)
      throw new ConnectorProblem(
        "failed",
        "Couldn't open a browser on your computer, so this can't be finished from here.",
      );
    this.#pending.set(state, pending);
    const expiresAt = pending.at + PENDING_MS;
    this.deps.hub.setSignIn(connectorId, { expiresAt, remote });
    return { opened, expiresAt, ...(opened ? {} : { url: page.href }) };
  }

  cancel(connectorId: string): void {
    this.#drop(connectorId);
    this.deps.hub.signInEnded(connectorId);
  }

  // The answer came from the service this sign-in went to, if it can say: an answer another service
  // sent is not read at all, not even its error.
  #fromIssuer(pending: Pending, iss: string | undefined): boolean {
    return iss === undefined ? !pending.issuerSaid : iss === pending.issuer;
  }

  // The app sent the user back with a refusal, or without a code.
  declined(state: string, iss: string | undefined): void {
    this.#sweep();
    const pending = this.#pending.get(state);
    if (!pending || !this.#fromIssuer(pending, iss)) return;
    this.#pending.delete(state);
    this.deps.hub.signInEnded(pending.connectorId, "The sign-in wasn't approved. Try again.");
  }

  // The app sent the user back: keyd redeems the code and keeps the tokens. Returns the app's name.
  async finish(state: string, code: string, iss?: string): Promise<string> {
    this.#sweep();
    const pending = this.#pending.get(state);
    if (!pending || !this.deps.hub.config(pending.connectorId))
      throw new ConnectorProblem("failed", "This sign-in has expired. Start again.");
    if (!this.#fromIssuer(pending, iss))
      throw new ConnectorProblem(
        "failed",
        "This sign-in came back from the wrong place. Start again.",
      );
    this.#pending.delete(state);
    const { connectorId, server } = pending;
    const id = connectorSecretId(connectorId);
    const binding: z.infer<typeof HttpBinding> = {
      id,
      kind: "http",
      hosts: [connectorHost(server.url)],
      header: "authorization",
      format: "bearer",
    };
    const secret = pending.client.client_secret;
    const grant: KeydOAuthGrant = {
      tokenEndpoint: pending.tokenEndpoint,
      clientId: pending.client.client_id,
      authMethod: pending.authMethod,
      code,
      codeVerifier: pending.verifier,
      redirectUri: pending.redirectUrl,
      ...(pending.revocationEndpoint ? { revocationEndpoint: pending.revocationEndpoint } : {}),
      ...(secret ? { clientSecret: secret } : {}),
      ...(pending.resource ? { resource: pending.resource } : {}),
    };
    try {
      await this.deps.keyd.connectOAuth(binding, grant);
    } catch (error) {
      const line = signInFailure(error);
      this.deps.hub.signInEnded(connectorId, line);
      throw new ConnectorProblem("failed", line);
    }
    this.deps.hub.signInEnded(connectorId);
    await this.deps.hub.update(connectorId, {
      server: { ...server, auth: { kind: "oauth", secret: id } },
    });
    await this.deps.hub.afterKeyChange(id);
    void this.deps.hub.refresh(connectorId);
    return this.deps.hub.config(connectorId)?.name ?? "the app";
  }
}

function signInFailure(error: unknown): string {
  if (error instanceof KeydError && error.code === KEYD_VAULT_LOCKED)
    return "Saved keys are locked. Unlock them, then connect again.";
  if (error instanceof KeydError && error.code === "oauth-unavailable")
    return "The app's sign-in service didn't answer. Try again.";
  return "The app didn't accept the sign-in. Try again.";
}

const html = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// What the browser tab shows when the app sends the user back.
export function callbackPage(title: string, line: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${html(title)}</title><style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f5f7;color:#1d1d1f}@media (prefers-color-scheme:dark){body{background:#111215;color:#f5f5f7}}main{max-width:360px;padding:24px;text-align:center}h1{font-size:20px;font-weight:600;margin:0 0 6px}p{margin:0;opacity:.7}</style></head><body><main><h1>${html(title)}</h1><p>${html(line)}</p></main></body></html>`;
}
