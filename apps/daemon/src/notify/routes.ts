import {
  type BannerKind,
  type KeydPushKey,
  NotifySeenRequest,
  NotifySettings,
  PushDeviceId,
  PushSubscriptionInput,
} from "@localdot/protocol";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import { KeydError, KeydUnavailableError } from "../keyd/client.ts";
import type { AttentionLedger } from "./attention.ts";
import type { Notifier } from "./notifier.ts";
import { type NotifyStore, NotifyStoreError } from "./store.ts";

export interface NotifyRoutesDeps {
  store: Pick<NotifyStore, "settings" | "putSettings" | "devices" | "subscribe" | "remove">;
  keyd: { pushKey(): Promise<KeydPushKey> };
  ledger: Pick<AttentionLedger, "snapshot" | "seen">;
  notifier: Pick<Notifier, "test">;
  banner: BannerKind;
}

const MAX_BODY = 8 * 1024;

// Registered after the /api bearer guard in createApp: every route needs the install token.
export function notifyRoutes(app: Hono, deps: NotifyRoutesDeps): void {
  const limit = bodyLimit({
    maxSize: MAX_BODY,
    onError: (c) => c.text("the request is too large", 413),
  });

  app.get("/api/notify/settings", (c) => c.json(deps.store.settings()));
  app.get("/api/notify/host", (c) => c.json({ banner: deps.banner }));
  app.put("/api/notify/settings", limit, async (c) => {
    const parsed = await body(c, NotifySettings);
    if (!parsed.success) return c.text(parsed.message, 400);
    return c.json(deps.store.putSettings(parsed.data));
  });

  app.get("/api/notify/key", async (c) => {
    try {
      return c.json({ publicKey: (await deps.keyd.pushKey()).publicKey });
    } catch (error) {
      if (error instanceof KeydError && error.code === "key-name-taken")
        return c.text(
          "A key named webpush-vapid blocks phone notifications. Remove it in Keys.",
          409,
        );
      if (error instanceof KeydUnavailableError) return c.text("the key layer is offline", 503);
      return c.text("phone notifications are unavailable right now", 503);
    }
  });

  app.get("/api/notify/subscriptions", (c) => c.json({ devices: deps.store.devices() }));
  app.post("/api/notify/subscriptions", limit, async (c) => {
    const parsed = await body(c, PushSubscriptionInput);
    if (!parsed.success) return c.text(parsed.message, 400);
    try {
      return c.json(deps.store.subscribe(parsed.data), 201);
    } catch (error) {
      if (error instanceof NotifyStoreError) return c.text(error.message, error.status);
      throw error;
    }
  });
  app.delete("/api/notify/subscriptions/:id", (c) => {
    const id = PushDeviceId.safeParse(c.req.param("id"));
    if (!id.success) return c.text("invalid device id", 400);
    return deps.store.remove(id.data) ? c.body(null, 204) : c.text("no such device", 404);
  });

  app.post("/api/notify/test", async (c) => c.json(await deps.notifier.test()));

  app.get("/api/notify/attention", (c) => c.json({ items: deps.ledger.snapshot() }));
  app.post("/api/notify/seen", limit, async (c) => {
    const parsed = await body(c, NotifySeenRequest);
    if (!parsed.success) return c.text(parsed.message, 400);
    deps.ledger.seen(parsed.data.sessionId);
    return c.body(null, 204);
  });
}

async function body<T extends z.ZodType>(
  c: Context,
  schema: T,
): Promise<{ success: true; data: z.infer<T> } | { success: false; message: string }> {
  if (c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
    return { success: false, message: "application/json is required" };
  let value: unknown;
  try {
    value = JSON.parse(await c.req.text());
  } catch {
    return { success: false, message: "the body is not JSON" };
  }
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { success: true, data: parsed.data }
    : { success: false, message: parsed.error.issues[0]?.message ?? "invalid request" };
}
