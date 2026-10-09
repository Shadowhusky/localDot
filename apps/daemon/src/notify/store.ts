import { createHash } from "node:crypto";
import {
  DEFAULT_NOTIFY_SETTINGS,
  MAX_PUSH_DEVICES,
  NotifySettings,
  type PushDevice,
  PushDeviceId,
  type PushSubscriptionInput,
  pushServiceOf,
} from "@localdot/protocol";
import { z } from "zod";
import { PrivateFiles } from "../agent/private-files.ts";

const MAX_FILE_BYTES = 64 * 1024;
// The endpoint is a capability URL and the keys decrypt nothing on their own, but together they
// let anyone message the device, so they stay in <home>/notify (0700) and never leave the daemon.
const StoredSubscription = z.strictObject({
  id: PushDeviceId,
  endpoint: z.string().max(1024),
  keys: z.strictObject({ p256dh: z.string().length(87), auth: z.string().length(22) }),
  label: z.string().max(40),
  service: z.string().max(16),
  createdAt: z.string(),
  lastSentAt: z.string().nullable(),
  lastResult: z.enum(["sent", "failed"]).nullable(),
});
export type StoredSubscription = z.infer<typeof StoredSubscription>;
const SubscriptionsFile = z.strictObject({
  v: z.literal(1),
  subscriptions: z.array(StoredSubscription).max(MAX_PUSH_DEVICES),
});

export class NotifyStoreError extends Error {
  constructor(
    readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "NotifyStoreError";
  }
}

// The same id a browser computes from its own subscription, so a page can tell whether it is on.
export function deviceIdOf(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex").slice(0, 16);
}

export class NotifyStore {
  readonly #files: PrivateFiles;
  readonly #now: () => Date;

  constructor(home: string, now: () => Date = () => new Date()) {
    this.#files = new PrivateFiles(home, "notify");
    this.#now = now;
  }

  // A missing or unreadable file means the defaults: a broken file must not silence Needs you.
  settings(): NotifySettings {
    try {
      const text = this.#files.text("settings.json", MAX_FILE_BYTES);
      return text === undefined ? DEFAULT_NOTIFY_SETTINGS : NotifySettings.parse(JSON.parse(text));
    } catch {
      console.error("notification settings are unreadable; using the defaults");
      return DEFAULT_NOTIFY_SETTINGS;
    }
  }

  putSettings(settings: NotifySettings): NotifySettings {
    const parsed = NotifySettings.parse(settings);
    this.#files.write("settings.json", `${JSON.stringify(parsed, null, 2)}\n`);
    return parsed;
  }

  subscriptions(): StoredSubscription[] {
    try {
      const text = this.#files.text("subscriptions.json", MAX_FILE_BYTES);
      return text === undefined ? [] : SubscriptionsFile.parse(JSON.parse(text)).subscriptions;
    } catch {
      console.error(
        "phone subscriptions are unreadable; phones need to turn notifications on again",
      );
      return [];
    }
  }

  devices(): PushDevice[] {
    return this.subscriptions().map(({ endpoint: _endpoint, keys: _keys, ...device }) => device);
  }

  subscribe(input: PushSubscriptionInput): PushDevice {
    const service = pushServiceOf(input.endpoint);
    if (!service) throw new NotifyStoreError(409, "This is not a browser push service.");
    const id = deviceIdOf(input.endpoint);
    const list = this.subscriptions();
    const existing = list.find((row) => row.id === id);
    if (!existing && list.length >= MAX_PUSH_DEVICES)
      throw new NotifyStoreError(
        409,
        `Notifications can be on for up to ${MAX_PUSH_DEVICES} devices. Remove one first.`,
      );
    const row: StoredSubscription = {
      id,
      endpoint: input.endpoint,
      keys: { p256dh: input.keys.p256dh, auth: input.keys.auth },
      label: input.label,
      service,
      createdAt: existing?.createdAt ?? this.#now().toISOString(),
      lastSentAt: existing?.lastSentAt ?? null,
      lastResult: existing?.lastResult ?? null,
    };
    this.#save([...list.filter((other) => other.id !== id), row]);
    const { endpoint: _endpoint, keys: _keys, ...device } = row;
    return device;
  }

  remove(id: string): boolean {
    const list = this.subscriptions();
    const kept = list.filter((row) => row.id !== id);
    if (kept.length === list.length) return false;
    this.#save(kept);
    return true;
  }

  recordResult(id: string, result: "sent" | "failed" | "gone"): void {
    if (result === "gone") {
      this.remove(id);
      return;
    }
    const list = this.subscriptions();
    const row = list.find((other) => other.id === id);
    if (!row) return;
    row.lastResult = result;
    if (result === "sent") row.lastSentAt = this.#now().toISOString();
    this.#save(list);
  }

  #save(subscriptions: StoredSubscription[]): void {
    this.#files.write(
      "subscriptions.json",
      `${JSON.stringify(SubscriptionsFile.parse({ v: 1, subscriptions }), null, 2)}\n`,
    );
  }
}
