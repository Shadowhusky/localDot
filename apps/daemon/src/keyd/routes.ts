import { SealedSecret, SecretId, surrogateEnvClash, surrogateEnvName } from "@localdot/protocol";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type KeydClient, KeydError, KeydUnavailableError } from "./client.ts";
import type { KeydMonitor } from "./monitor.ts";

export interface KeyRoutesDeps {
  keyd: KeydClient;
  monitor: KeydMonitor;
  // Hands running computers their new surrogates once a key is saved or deleted.
  afterChange?: (secretId: string) => Promise<{ restart: boolean }>;
}

// A sealed v1 blob of the largest value keyd takes is about 11 KB; nothing a browser sends here
// is legitimately bigger.
const MAX_BODY = 64 * 1024;

// The key form's API. The browser seals each key to keyd's per-boot key before it leaves the page,
// so these routes carry only a binding and ciphertext: a body with any other field (a plaintext
// "value" above all) is refused, and the daemon relays the rest to keyd without changing a byte.
export function keyRoutes(app: Hono, { keyd, monitor, afterChange }: KeyRoutesDeps): void {
  // Checking names, storing/deleting, and updating computers form one ordered change. Two
  // concurrent saves must not both reserve the same environment variable (a-b versus a_b).
  let pending: Promise<unknown> = Promise.resolve();
  const mutate = (fn: () => Promise<Response>): Promise<Response> => {
    const work = pending.then(fn);
    pending = work.catch(() => {});
    return work;
  };
  const notifyChange = async (id: string): Promise<{ restart: boolean }> => {
    try {
      return (await afterChange?.(id)) ?? { restart: false };
    } catch {
      // The key is already saved/deleted. Do not tell the UI that persistence failed, or log a
      // callback's potentially sensitive diagnostics. Deleted keys are already revoked by keyd.
      console.error("key saved or deleted, but refreshing computers failed");
      return { restart: true };
    }
  };
  app.get("/api/keyd", async (c) => c.json(await monitor.refresh()));

  app.get("/api/keys", (c) => withKeyd(c, async () => c.json({ keys: await keyd.secrets() })));

  const limit = bodyLimit({
    maxSize: MAX_BODY,
    onError: (c) => refuse(c, 413, "too-large", "the request is too large"),
  });

  app.post("/api/keys", limit, async (c) => {
    const text = await c.req.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return refuse(c, 400, "bad-request", "the body is not JSON");
    }
    const parsed = SealedSecret.safeParse(body);
    if (!parsed.success) {
      return refuse(
        c,
        400,
        "bad-request",
        "send a sealed key: { binding, sealed } and nothing else",
      );
    }
    const { binding, sealed } = parsed.data;
    return withKeyd(c, () =>
      mutate(async () => {
        const clash = surrogateEnvClash(
          binding.id,
          (await keyd.secrets()).map((r) => r.id),
        );
        if (clash) {
          const message = `${binding.id} and ${clash} would share ${surrogateEnvName(binding.id)} in your computer: pick another name`;
          return refuse(c, 409, "name-taken", message);
        }
        const key = await keyd.putSecret(binding, sealed);
        const { restart } = await notifyChange(key.id);
        return c.json({ key, restart });
      }),
    );
  });

  app.delete("/api/keys/:id", async (c) => {
    const id = SecretId.safeParse(c.req.param("id"));
    if (!id.success) return refuse(c, 400, "bad-request", "not a key name");
    return withKeyd(c, () =>
      mutate(async () => {
        if (!(await keyd.deleteSecret(id.data))) return refuse(c, 404, "not-found", "no such key");
        await notifyChange(id.data);
        return c.body(null, 204);
      }),
    );
  });
}

async function withKeyd(c: Context, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof KeydUnavailableError) {
      return refuse(c, 503, "key-layer-offline", "the key layer is offline: start keyd");
    }
    if (err instanceof KeydError) {
      // bad-seal: keyd restarted with a new seal key, or the binding changed after sealing; the UI
      // fetches /api/keyd again and seals once more.
      if (err.code === "bad-seal") return refuse(c, 409, "bad-seal", "seal the key again");
      if (err.code === "vault") return refuse(c, 502, "vault", "keyd could not store the key");
      if (err.status === 404) return refuse(c, 404, "not-found", "no such key");
      if (err.status >= 400 && err.status < 500) return refuse(c, 400, err.code, err.detail);
      return refuse(c, 502, err.code, "keyd failed");
    }
    throw err;
  }
}

function refuse(
  c: Context,
  status: 400 | 404 | 409 | 413 | 502 | 503,
  error: string,
  message: string,
): Response {
  return c.json({ error, message }, status);
}
