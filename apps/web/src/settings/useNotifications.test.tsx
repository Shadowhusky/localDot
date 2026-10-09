// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { DEFAULT_NOTIFY_SETTINGS } from "@localdot/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import type { DeviceEnv } from "../notify/this-device.ts";
import { notifyDaemonFixture } from "./testing.ts";
import { useNotifications } from "./useNotifications.ts";

const thisMac: DeviceEnv = {
  hostname: "127.0.0.1",
  isSecureContext: true,
  userAgent: "Mozilla/5.0 (Macintosh)",
  maxTouchPoints: 0,
  standalone: false,
  pushSupported: true,
  subtle: webcrypto.subtle as unknown as SubtleCrypto,
};

describe("useNotifications", () => {
  it("reads nothing until Settings opens, then this Mac's state, and saves a switch at once", async () => {
    const d = notifyDaemonFixture();
    const { result, rerender } = renderHook(
      ({ active }) => useNotifications(d.api, active, { env: thisMac }),
      { initialProps: { active: false } },
    );
    expect(d.calls).toEqual([]);
    rerender({ active: true });
    await waitFor(() => expect(result.current.settings).toEqual(DEFAULT_NOTIFY_SETTINGS));
    expect(result.current.device).toEqual({ kind: "this-mac" });
    expect(result.current.name).toBe("This Mac");
    const next = {
      ...DEFAULT_NOTIFY_SETTINGS,
      events: { ...DEFAULT_NOTIFY_SETTINGS.events, done: { mac: true, phone: false } },
    };
    act(() => result.current.save(next));
    expect(result.current.settings).toEqual(next);
    await waitFor(() => expect(d.current().events.done.phone).toBe(false));
  });

  it("puts the control back and says why when a save fails", async () => {
    const d = notifyDaemonFixture(true);
    const toast = vi.fn();
    const { result } = renderHook(() => useNotifications(d.api, true, { env: thisMac, toast }));
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    act(() => result.current.save({ ...DEFAULT_NOTIFY_SETTINGS, showTaskText: true }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith({
        title: "Quiet hours need different start and end times.",
        tone: "danger",
      }),
    );
    expect(result.current.settings?.showTaskText).toBe(false);
  });

  it("sends a test, and copies a Home Screen sign-in link", async () => {
    const d = notifyDaemonFixture();
    const clipboard = { writeText: vi.fn(async () => {}) };
    const toast = vi.fn();
    const { result } = renderHook(() =>
      useNotifications(d.api, true, { env: thisMac, clipboard, toast }),
    );
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    act(() => result.current.test());
    await waitFor(() => expect(result.current.result?.line).toMatch(/^Sent to this Mac\./));
    act(() => result.current.copyLink());
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Sign-in link copied" })),
    );
    expect(clipboard.writeText).toHaveBeenCalledWith(
      `${window.location.origin}/#code=${"C".repeat(43)}`,
    );
  });

  it("lets a tab on this Mac show notifications itself", async () => {
    const d = notifyDaemonFixture();
    const request = vi.fn(async () => "granted" as const);
    const env: DeviceEnv = {
      ...thisMac,
      notification: { permission: () => "default", request },
    };
    const { result } = renderHook(() => useNotifications(d.api, true, { env }));
    await waitFor(() => expect(result.current.device).toEqual({ kind: "this-mac" }));
    expect(result.current.tab).toBe("default");
    act(() => result.current.allowTab());
    await waitFor(() => expect(result.current.tab).toBe("granted"));
    expect(request).toHaveBeenCalledOnce();
  });

  it("offers to read again when the settings can't be read", async () => {
    let up = false;
    const api = createApi("t".repeat(43), {
      origin: "http://127.0.0.1:4750",
      fetchImpl: (async (input: string | URL | Request) => {
        if (!up) return new Response("down", { status: 503 });
        const path = new URL(String(input)).pathname;
        return path === "/api/notify/settings"
          ? Response.json(DEFAULT_NOTIFY_SETTINGS)
          : Response.json({ devices: [] });
      }) as unknown as typeof fetch,
    });
    const { result } = renderHook(() => useNotifications(api, true, { env: thisMac }));
    await waitFor(() => expect(result.current.failed).toBe(true));
    up = true;
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.settings).toEqual(DEFAULT_NOTIFY_SETTINGS));
    expect(result.current.failed).toBe(false);
  });
});
