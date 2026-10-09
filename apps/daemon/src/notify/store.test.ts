import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_NOTIFY_SETTINGS } from "@localdot/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deviceIdOf, NotifyStore, NotifyStoreError } from "./store.ts";
import { browserKeys } from "./testing/ece-decrypt.ts";

let home: string;
let store: NotifyStore;
const at = new Date("2026-10-08T09:00:00Z");
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ld-notify-store-"));
  store = new NotifyStore(home, () => at);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const subscription = (n: number) => {
  const { p256dh, auth } = browserKeys();
  return {
    endpoint: `https://web.push.apple.com/device-${n}`,
    keys: { p256dh, auth },
    label: `Phone ${n}`,
  };
};

describe("NotifyStore", () => {
  it("starts with the defaults and keeps saved settings in a private file", () => {
    expect(store.settings()).toEqual(DEFAULT_NOTIFY_SETTINGS);
    const quiet = {
      ...DEFAULT_NOTIFY_SETTINGS,
      quietHours: { enabled: true, start: "22:00", end: "07:00", allowNeedsYou: true },
    };
    store.putSettings(quiet);
    expect(new NotifyStore(home).settings()).toEqual(quiet);
    expect(statSync(join(home, "notify", "settings.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "notify")).mode & 0o777).toBe(0o700);
  });

  it("falls back to the defaults when the settings file is damaged", () => {
    store.putSettings(DEFAULT_NOTIFY_SETTINGS);
    writeFileSync(join(home, "notify", "settings.json"), "{not json");
    expect(store.settings()).toEqual(DEFAULT_NOTIFY_SETTINGS);
  });

  it("stores a subscription 0600 and lists devices without endpoints or keys", () => {
    const device = store.subscribe(subscription(1));
    expect(device).toEqual({
      id: deviceIdOf("https://web.push.apple.com/device-1"),
      label: "Phone 1",
      service: "Apple",
      createdAt: at.toISOString(),
      lastSentAt: null,
      lastResult: null,
    });
    expect(JSON.stringify(store.devices())).not.toContain("device-1");
    const file = join(home, "notify", "subscriptions.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain("https://web.push.apple.com/device-1");
  });

  it("updates the same endpoint in place and caps devices at ten", () => {
    store.subscribe(subscription(1));
    store.subscribe({ ...subscription(1), label: "Renamed" });
    expect(store.devices().map((d) => d.label)).toEqual(["Renamed"]);
    for (let n = 2; n <= 10; n++) store.subscribe(subscription(n));
    expect(() => store.subscribe(subscription(11))).toThrow(NotifyStoreError);
  });

  it("refuses an endpoint that is not a browser push service", () => {
    const input = { ...subscription(1), endpoint: "https://push.apple.com.evil.example/x" };
    expect(() => store.subscribe(input)).toThrow(NotifyStoreError);
    expect(store.devices()).toEqual([]);
  });

  it("records results and drops a gone subscription", () => {
    const { id } = store.subscribe(subscription(1));
    store.recordResult(id, "sent");
    expect(store.devices()[0]).toMatchObject({ lastResult: "sent", lastSentAt: at.toISOString() });
    store.recordResult(id, "gone");
    expect(store.devices()).toEqual([]);
    expect(store.remove(id)).toBe(false);
  });
});
