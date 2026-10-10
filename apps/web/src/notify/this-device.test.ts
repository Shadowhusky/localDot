// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import type { PushSubscriptionInput } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api.ts";
import type { NotifyApi } from "./notify-api.ts";
import {
  type DeviceEnv,
  deviceIdOf,
  deviceLabel,
  deviceState,
  isHomeScreenApp,
  turnOffThisDevice,
  turnOnThisDevice,
} from "./this-device.ts";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const ENDPOINT = "https://web.push.apple.com/QGuR-device";
const KEY = `B${"A".repeat(86)}`;
const subtle = webcrypto.subtle as unknown as SubtleCrypto;

function fakePush(existing: string | null = null) {
  let current = existing
    ? { endpoint: existing, unsubscribe: vi.fn(async () => true), toJSON: () => ({}) }
    : null;
  const pushManager = {
    getSubscription: async () => current,
    subscribe: vi.fn(async () => {
      current = {
        endpoint: ENDPOINT,
        unsubscribe: vi.fn(async () => true),
        toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: KEY, auth: "A".repeat(22) } }),
      };
      return current;
    }),
  };
  const registration = { pushManager } as unknown as ServiceWorkerRegistration;
  return {
    pushManager,
    serviceWorker: {
      register: vi.fn(async () => registration),
      getRegistration: async () => registration,
      ready: Promise.resolve(registration),
    } as unknown as DeviceEnv["serviceWorker"],
  };
}

function env(overrides: Partial<DeviceEnv> = {}, permission: NotificationPermission = "default") {
  let granted = permission;
  return {
    hostname: "mac.example.ts.net",
    isSecureContext: true,
    userAgent: IPHONE,
    maxTouchPoints: 5,
    standalone: true,
    pushSupported: true,
    notification: {
      permission: () => granted,
      request: vi.fn(async () => {
        granted = granted === "default" ? "granted" : granted;
        return granted;
      }),
    },
    subtle,
    ...fakePush(),
    ...overrides,
  } satisfies DeviceEnv;
}

function api(): NotifyApi & { added: unknown[] } {
  const added: unknown[] = [];
  return {
    added,
    key: async () => KEY,
    addDevice: async (input: PushSubscriptionInput) => {
      added.push(input);
      return {
        id: await deviceIdOf(input.endpoint, subtle),
        label: input.label,
        service: "Apple",
        createdAt: "2026-10-08T09:00:00Z",
        lastSentAt: null,
        lastResult: null,
      };
    },
    removeDevice: vi.fn(async () => {
      throw new ApiError(404, "no such device");
    }),
  } as unknown as NotifyApi & { added: unknown[] };
}

describe("this device", () => {
  it("explains what each browser needs before it can turn on", async () => {
    expect(
      await deviceState(
        [],
        env({ hostname: "127.0.0.1", userAgent: "Mozilla/5.0 (Macintosh)", maxTouchPoints: 0 }),
      ),
    ).toEqual({ kind: "this-mac" });
    expect(await deviceState([], env({ isSecureContext: false }))).toEqual({ kind: "needs-https" });
    expect(await deviceState([], env({ standalone: false }))).toEqual({
      kind: "needs-home-screen",
    });
    expect(await deviceState([], env({ pushSupported: false }))).toEqual({ kind: "unsupported" });
    expect(await deviceState([], env({}, "denied"))).toEqual({ kind: "blocked" });
    expect(await deviceState([], env())).toEqual({ kind: "off" });
    expect(
      await deviceState(
        [],
        env({
          hostname: "localhost",
          userAgent: "Mozilla/5.0 (Windows NT 10.0)",
          maxTouchPoints: 0,
        }),
      ),
    ).toEqual({ kind: "off" });
  });

  it("asks permission first, subscribes with the Mac's key and registers the device", async () => {
    const e = env();
    const a = api();
    const state = await turnOnThisDevice(a, e);
    expect(e.notification.request).toHaveBeenCalledOnce();
    expect(state).toEqual({ kind: "on", id: await deviceIdOf(ENDPOINT, subtle) });
    expect(a.added).toEqual([
      { endpoint: ENDPOINT, keys: { p256dh: KEY, auth: "A".repeat(22) }, label: "iPhone" },
    ]);
    expect(await deviceState([state.kind === "on" ? state.id : ""], e)).toEqual(state);
    expect(await deviceState([], e)).toEqual({ kind: "off" });
  });

  it("stays off when the prompt is dismissed and says blocked when refused", async () => {
    const dismissed = env();
    dismissed.notification.request = vi.fn(async () => "default" as const);
    expect(await turnOnThisDevice(api(), dismissed)).toEqual({ kind: "off" });
    const refused = env();
    refused.notification.request = vi.fn(async () => "denied" as const);
    expect(await turnOnThisDevice(api(), refused)).toEqual({ kind: "blocked" });
  });

  it("turns off: unsubscribes here and forgets the device even if the Mac already has", async () => {
    const e = env({ ...fakePush(ENDPOINT) });
    const a = api();
    expect(await turnOffThisDevice(a, e)).toEqual({ kind: "off" });
    expect(a.removeDevice).toHaveBeenCalledWith(await deviceIdOf(ENDPOINT, subtle));
  });

  it("names devices plainly", () => {
    expect(deviceLabel(IPHONE, 5)).toBe("iPhone");
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe("iPad");
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0)).toBe("Mac");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 16; Pixel) Mobile", 5)).toBe("Android phone");
  });

  it("signs in apart only from an iPhone or iPad Home Screen", () => {
    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
    expect(isHomeScreenApp({ userAgent: IPHONE, maxTouchPoints: 5 }, true)).toBe(true);
    expect(isHomeScreenApp({ userAgent: mac, maxTouchPoints: 5 }, true)).toBe(true);
    expect(isHomeScreenApp({ userAgent: IPHONE, maxTouchPoints: 5 }, false)).toBe(false);
    expect(isHomeScreenApp({ userAgent: mac, maxTouchPoints: 0 }, true)).toBe(false);
    expect(
      isHomeScreenApp(
        { userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel) Mobile", maxTouchPoints: 5 },
        true,
      ),
    ).toBe(false);
  });

  it("computes the same device id as the Mac", async () => {
    const { createHash } = await import("node:crypto");
    expect(await deviceIdOf(ENDPOINT, subtle)).toBe(
      createHash("sha256").update(ENDPOINT).digest("hex").slice(0, 16),
    );
  });
});
