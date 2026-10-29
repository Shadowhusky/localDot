import {
  KEYD_VAULT_LOCKED,
  KeyMetadata,
  SECRET_ID_PATTERN,
  SealedSecret,
  scanKeyLike,
  surrogateEnvClash,
  surrogateEnvName,
  VaultUnlock,
} from "@localdot/protocol";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type KeydClient, KeydError, KeydUnavailableError } from "./client.ts";
import { type KeydMonitor, vaultLocked } from "./monitor.ts";
import type { PassphraseRecord } from "./passphrase-record.ts";

export interface KeyRoutesDeps {
  keyd: KeydClient;
  monitor: KeydMonitor;
  // Hands running computers their new surrogates once a key is saved or deleted.
  afterChange?: (secretId: string) => Promise<{ restart: boolean }>;
  // Notes the vault whose passphrase was chosen or entered here, as localdot unlock does.
  passphrases?: Pick<PassphraseRecord, "remember">;
  now?: () => number;
}

export const VAULT_LOCKED = "Saved keys are locked. Unlock them in Keys, then try again.";

// A sealed v1 blob of the largest value keyd takes is about 11 KB; nothing a browser sends here
// is legitimately bigger.
const MAX_BODY = 64 * 1024;
// A passphrase is at most 1024 bytes, which seals to under 1.5 KB.
const MAX_UNLOCK_BODY = 4 * 1024;

// Wrong passphrases from the app: five tries, then a wait that doubles from 30 s up to 15 min, so
// a page left open or a stolen owner link can't guess at keyd's pace. A right one clears it.
const FREE_TRIES = 5;
const FIRST_WAIT_MS = 30_000;
const MAX_WAIT_MS = 15 * 60_000;

class UnlockThrottle {
  #failures = 0;
  #until = 0;
  constructor(private readonly now: () => number) {}
  waitMs(): number {
    return Math.max(0, this.#until - this.now());
  }
  failed(): void {
    this.#failures++;
    if (this.#failures >= FREE_TRIES)
      this.#until =
        this.now() + Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** (this.#failures - FREE_TRIES));
  }
  passed(): void {
    this.#failures = 0;
    this.#until = 0;
  }
}

// The key form's API. The browser seals each key to keyd's per-boot key before it leaves the page,
// so these routes carry only a binding and ciphertext: a body with any other field (a plaintext
// "value" above all) is refused, and the daemon relays the rest to keyd without changing a byte.
export function keyRoutes(
  app: Hono,
  { keyd, monitor, afterChange, passphrases, now = Date.now }: KeyRoutesDeps,
): void {
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

  // The passphrase vault's unlock, and its first passphrase. The page seals the passphrase to
  // keyd's boot key, so this daemon relays ciphertext it cannot open, and never logs or keeps it.
  const throttle = new UnlockThrottle(now);
  const unlockLimit = bodyLimit({
    maxSize: MAX_UNLOCK_BODY,
    onError: (c) => refuse(c, 413, "too-large", "the request is too large"),
  });
  app.post("/api/keyd/unlock", unlockLimit, async (c) => {
    // A shared link is someone else's view of this localDot; only the owner's own token unlocks.
    if (c.get("remoteGrant"))
      return refuse(c, 403, "owner-only", "Only the owner of this localDot can unlock its keys");
    const input = VaultUnlock.safeParse(await c.req.json().catch(() => null));
    if (!input.success)
      return refuse(
        c,
        400,
        "bad-request",
        "send the sealed passphrase: { sealed } and nothing else",
      );
    return withKeyd(c, () =>
      mutate(async () => {
        const wait = throttle.waitMs();
        if (wait > 0) return tooManyTries(c, wait);
        const { vault } = await keyd.status();
        if (!vault || vault.state === "ready") return c.json({ vault: vault ?? null });
        let opened: Awaited<ReturnType<KeydClient["unlockVault"]>>;
        try {
          opened = await keyd.unlockVault(input.data.sealed);
        } catch (err) {
          if (!(err instanceof KeydError) || err.status !== 403) throw err;
          throttle.failed();
          return refuse(
            c,
            403,
            "wrong-passphrase",
            "That passphrase doesn't unlock your saved keys",
          );
        }
        throttle.passed();
        try {
          if (opened.fingerprint) passphrases?.remember(opened.fingerprint);
        } catch {
          console.error("the unlocked vault could not be noted as chosen here");
        }
        // A poll begun before the unlock would still read the vault locked.
        if (vaultLocked(await monitor.refresh())) await monitor.refresh();
        return c.json({ vault: opened });
      }),
    );
  });

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
    const { binding, sealed, metadata } = parsed.data;
    if (metadata && hasKey(metadata))
      return refuse(c, 400, "bad-metadata", "Do not put a secret in the key description");
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
        const key = await keyd.putSecret(binding, sealed, ...(metadata ? [metadata] : []));
        const { restart } = await notifyChange(key.id);
        return c.json({ key, restart });
      }),
    );
  });

  app.put("/api/keys/:id/metadata", limit, async (c) => {
    const id = c.req.param("id");
    const metadata = KeyMetadata.safeParse(await c.req.json().catch(() => null));
    if (!SECRET_ID_PATTERN.test(id) || !metadata.success || hasKey(metadata.data))
      return refuse(c, 400, "bad-metadata", "Use a short description without secret values");
    return withKeyd(c, () =>
      mutate(async () => c.json({ key: await keyd.putMetadata(id, metadata.data) })),
    );
  });

  app.delete("/api/keys/:id", async (c) => {
    // The name pattern only: a key whose name was reserved after it was added (webpush-vapid)
    // must still be removable.
    const id = c.req.param("id");
    if (!SECRET_ID_PATTERN.test(id)) return refuse(c, 400, "bad-request", "not a key name");
    return withKeyd(c, () =>
      mutate(async () => {
        if (!(await keyd.deleteSecret(id))) return refuse(c, 404, "not-found", "no such key");
        await notifyChange(id);
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
      return refuse(
        c,
        503,
        "key-layer-offline",
        "key protection is off: turn it back on, then try again",
      );
    }
    if (err instanceof KeydError) {
      // bad-seal: keyd restarted with a new seal key, or the binding changed after sealing; the UI
      // fetches /api/keyd again and seals once more.
      if (err.code === "bad-seal") return refuse(c, 409, "bad-seal", "seal the key again");
      if (err.code === KEYD_VAULT_LOCKED) return refuse(c, 423, KEYD_VAULT_LOCKED, VAULT_LOCKED);
      if (err.code === "vault")
        return refuse(c, 502, "vault", "key protection could not store the key");
      if (err.status === 404) return refuse(c, 404, "not-found", "no such key");
      if (err.status >= 400 && err.status < 500) return refuse(c, 400, err.code, err.detail);
      return refuse(c, 502, err.code, "key protection failed");
    }
    throw err;
  }
}

function refuse(
  c: Context,
  status: 400 | 403 | 404 | 409 | 413 | 423 | 502 | 503,
  error: string,
  message: string,
): Response {
  return c.json({ error, message }, status);
}

function tooManyTries(c: Context, waitMs: number): Response {
  const retryAfter = Math.ceil(waitMs / 1000);
  c.header("Retry-After", String(retryAfter));
  return c.json(
    {
      error: "too-many-tries",
      message: "Too many wrong passphrases. Wait a little, then try again",
      retryAfter,
    },
    429,
  );
}

function hasKey(metadata: Record<string, string | undefined>): boolean {
  const scan = scanKeyLike(Object.values(metadata).join(" "));
  return scan.overflow || scan.matches.length > 0;
}
