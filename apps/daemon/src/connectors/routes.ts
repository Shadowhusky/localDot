import {
  CONNECTOR_CATALOG,
  type ConnectorConfig,
  ConnectorDraft,
  ConnectorPatch,
  type ConnectorServer,
  connectorHost,
  connectorSecretId,
  isConnectorSecret,
  type KeydRecord,
} from "@localdot/protocol";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requestOrigin } from "../guard.ts";
import type { KeydClient } from "../keyd/client.ts";
import type { ConnectorHub } from "./hub.ts";
import { CALLBACK_PATH, type ConnectorSignIn, callbackPage } from "./oauth.ts";
import { ConnectorProblem } from "./problem.ts";
import { ConnectorStoreError } from "./store.ts";

export interface ConnectorRoutesDeps {
  hub: ConnectorHub;
  keyd: Pick<KeydClient, "secrets" | "deleteSecret">;
  signIn?: ConnectorSignIn;
  // The daemon's port, to name the origin the app sends the user back to.
  port: number;
}

const MAX_BODY = 64 * 1024;

// A connector's keys must be web keys bound to where they are used: the remote server's own host,
// or (for a program in a connector cell) the hosts its key was saved for.
export function keyProblem(
  server: ConnectorServer,
  keys: readonly KeydRecord[],
): string | undefined {
  const find = (id: string) => keys.find((key) => key.id === id);
  if (server.kind === "remote") {
    if (server.auth.kind !== "key") return undefined;
    const key = find(server.auth.secret);
    const host = connectorHost(server.url);
    if (!key) return "Add the app's key first.";
    if (key.kind !== "http" || !(key.hosts ?? []).includes(host))
      return `That key isn't for ${host}. Add a key for this address.`;
    if (!["bearer", "raw"].includes(key.format ?? "")) return "Use a key sent as a header.";
    return undefined;
  }
  for (const env of server.env) {
    if (!env.secret) continue;
    const key = find(env.secret);
    if (!key) return "Add the app's key first.";
    if (key.kind !== "http") return "Use a web key for an app's program.";
  }
  return undefined;
}

// The keys a connector made for itself, removed with it.
function ownKeys(config: ConnectorConfig): string[] {
  const { server } = config;
  const named =
    server.kind === "remote"
      ? server.auth.kind === "none" || !server.auth.secret
        ? []
        : [server.auth.secret]
      : server.env.flatMap((env) => (env.secret ? [env.secret] : []));
  const own = connectorSecretId(config.id);
  return named.filter((id) => isConnectorSecret(id) && (id === own || id.startsWith(`${own}-`)));
}

function refuse(c: Context, status: 400 | 404 | 409 | 503, error: string, message: string) {
  return c.json({ error, message }, status);
}

async function guarded(c: Context, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ConnectorStoreError) return refuse(c, 409, "unreadable", error.message);
    if (error instanceof ConnectorProblem) return refuse(c, 400, error.status, error.message);
    throw error;
  }
}

// Settings > Connectors: the user's apps, the catalogue, and each app's tools and choices.
export function connectorRoutes(app: Hono, { hub, keyd, signIn, port }: ConnectorRoutesDeps): void {
  const limit = bodyLimit({
    maxSize: MAX_BODY,
    onError: (c) => refuse(c, 400, "too-large", "the request is too large"),
  });
  const keys = () => keyd.secrets().catch(() => [] as KeydRecord[]);
  const body = async (c: Context): Promise<unknown> => {
    try {
      return await c.req.json();
    } catch {
      return undefined;
    }
  };
  const viewOf = async (c: Context, id: string, status: 200 | 201 = 200) => {
    const view = await hub.view(id);
    return view ? c.json({ connector: view }, status) : refuse(c, 404, "not-found", "no such app");
  };

  app.get("/api/connectors", (c) =>
    guarded(c, async () => c.json({ connectors: await hub.views(), catalog: CONNECTOR_CATALOG })),
  );

  app.post("/api/connectors", limit, (c) =>
    guarded(c, async () => {
      const parsed = ConnectorDraft.safeParse(await body(c));
      if (!parsed.success)
        return refuse(c, 400, "bad-request", parsed.error.issues[0]?.message ?? "check the app");
      const problem = keyProblem(parsed.data.server, await keys());
      if (problem) return refuse(c, 400, "needs_key", problem);
      const config = hub.add(parsed.data);
      void hub.refresh(config.id);
      return viewOf(c, config.id, 201);
    }),
  );

  app.put("/api/connectors/:id", limit, (c) =>
    guarded(c, async () => {
      const parsed = ConnectorPatch.safeParse(await body(c));
      if (!parsed.success)
        return refuse(c, 400, "bad-request", parsed.error.issues[0]?.message ?? "check the change");
      if (parsed.data.server) {
        const problem = keyProblem(parsed.data.server, await keys());
        if (problem) return refuse(c, 400, "needs_key", problem);
      }
      const id = c.req.param("id");
      const before = hub.config(id);
      const config = await hub.update(id, parsed.data);
      if (!config) return refuse(c, 404, "not-found", "no such app");
      if (config.enabled && (parsed.data.server || (parsed.data.enabled && !before?.enabled)))
        void hub.refresh(id);
      return viewOf(c, id);
    }),
  );

  // Lists the app's tools again; a program that runs on this Mac may take a while to start, so
  // the page follows the status rather than waiting here.
  app.post("/api/connectors/:id/refresh", (c) =>
    guarded(c, async () => {
      const id = c.req.param("id");
      if (!hub.config(id)) return refuse(c, 404, "not-found", "no such app");
      const done = hub.refresh(id);
      await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      return viewOf(c, id);
    }),
  );

  // The app's sign-in page; it sends the user back to this daemon at the address they use.
  app.post("/api/connectors/:id/sign-in", (c) =>
    guarded(c, async () => {
      const origin = requestOrigin(c.req.header("host"), port);
      if (!signIn || !origin) return refuse(c, 503, "unavailable", "Signing in isn't available.");
      const id = c.req.param("id");
      if (!hub.config(id)) return refuse(c, 404, "not-found", "no such app");
      return c.json({ url: await signIn.start(id, origin) });
    }),
  );

  app.delete("/api/connectors/:id", (c) =>
    guarded(c, async () => {
      const config = await hub.remove(c.req.param("id"));
      if (!config) return refuse(c, 404, "not-found", "no such app");
      for (const id of ownKeys(config)) await keyd.deleteSecret(id).catch(() => false);
      return c.body(null, 204);
    }),
  );
}

// Where an app sends the user back after they signed in. It carries no install token (the app's
// redirect can't), so the one-time state from the sign-in this daemon started is its authority.
export function connectorCallbackRoute(app: Hono, signIn: ConnectorSignIn): void {
  app.get(CALLBACK_PATH, async (c) => {
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    c.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'");
    const state = c.req.query("state") ?? "";
    const code = c.req.query("code") ?? "";
    if (!state || !code || c.req.query("error"))
      return c.html(
        callbackPage("Not signed in", "The app didn't finish signing in. Try again from localDot."),
        400,
      );
    try {
      const name = await signIn.finish(state, code);
      return c.html(
        callbackPage(`Signed in to ${name}`, "You can close this tab and go back to localDot."),
      );
    } catch (error) {
      const line =
        error instanceof ConnectorProblem ? error.message : "Something went wrong. Try again.";
      return c.html(callbackPage("Not signed in", line), 400);
    }
  });
}
