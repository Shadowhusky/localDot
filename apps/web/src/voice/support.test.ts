// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../lib/api.ts";
import { browserSpeech, macSpeech, useVoiceSupport, voiceRoute } from "./support.ts";
import { routeBlocked, routeLabel } from "./words.ts";

const brands = (...names: string[]) =>
  Object.defineProperty(navigator, "userAgentData", {
    configurable: true,
    value: { brands: names.map((brand) => ({ brand, version: "154" })) },
  });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "userAgentData");
});

describe("where speech becomes text", () => {
  it("prefers an installed local engine, then this device, and goes online only when allowed", () => {
    expect(voiceRoute({ browser: "local", mac: "all" }, false, "en-US")).toEqual({
      kind: "mac",
    });
    expect(voiceRoute({ browser: "local", mac: null }, false, "en-US")).toEqual({ kind: "device" });
    expect(voiceRoute({ browser: "online", mac: "all" }, true, "ja-JP")).toEqual({ kind: "mac" });
    expect(voiceRoute({ browser: "online", mac: "en" }, false, "ja-JP")).toEqual({
      kind: "none",
      why: "online-off",
    });
    expect(voiceRoute({ browser: "online", mac: "en" }, false, "en-GB")).toEqual({ kind: "mac" });
    expect(voiceRoute({ browser: "online", mac: null }, true, "en-US")).toEqual({
      kind: "online",
    });
    expect(voiceRoute({ browser: "download", mac: null }, false, "en-US")).toEqual({
      kind: "none",
      why: "download",
    });
    expect(voiceRoute({ browser: "none", mac: null }, true, "en-US")).toEqual({
      kind: "none",
      why: "unsupported",
    });
    expect(voiceRoute(null, true, "en-US")).toEqual({ kind: "none", why: "checking" });
  });

  it("names the route and why the mic can't be used", () => {
    expect(routeLabel({ kind: "device" })).toBe("On this device");
    expect(routeLabel({ kind: "mac" })).toBe("On your Mac");
    expect(routeLabel({ kind: "online" })).toBe("Online");
    expect(routeBlocked({ kind: "none", why: "checking" })).toContain("Checking speech support");
    expect(routeBlocked({ kind: "none", why: "download" })).toBeUndefined();
    expect(routeBlocked({ kind: "none", why: "unsupported" })).toBe(
      "This browser can't turn speech into text.",
    );
  });

  it("asks the browser for speech on this device only", async () => {
    brands("Chromium", "Google Chrome");
    expect(await browserSpeech("en-US")).toBe("none");
    vi.stubGlobal("webkitSpeechRecognition", class {});
    expect(await browserSpeech("en-US")).toBe("online");
    const available = vi.fn(async () => "downloadable");
    vi.stubGlobal("SpeechRecognition", Object.assign(class {}, { available }));
    expect(await browserSpeech("ja-JP")).toBe("download");
    expect(available).toHaveBeenCalledWith({ langs: ["ja-JP"], processLocally: true });
    available.mockResolvedValue("available");
    expect(await browserSpeech("ja-JP")).toBe("local");
    available.mockResolvedValue("unavailable");
    expect(await browserSpeech("ja-JP")).toBe("online");
  });

  it("never asks a Chromium build that is not Chrome, which closes the tab that asks", async () => {
    const available = vi.fn(async () => "available");
    vi.stubGlobal("SpeechRecognition", Object.assign(class {}, { available }));
    brands("Chromium");
    expect(await browserSpeech("en-US")).toBe("online");
    expect(available).not.toHaveBeenCalled();
  });

  it("asks the computer for its speech model", async () => {
    const api = (reply: unknown) =>
      ({
        get: vi.fn(async () => {
          if (reply instanceof Error) throw reply;
          return reply;
        }),
      }) as unknown as ApiClient;
    expect(await macSpeech(api({ onMac: { available: true, englishOnly: false } }))).toBe("all");
    expect(await macSpeech(api({ onMac: { available: true, englishOnly: true } }))).toBe("en");
    expect(await macSpeech(api({ onMac: { available: false } }))).toBeNull();
    expect(await macSpeech(api(new Error("404")))).toBeNull();
  });
});

it("explains insecure remote links before attempting to open the microphone", () => {
  vi.stubGlobal("isSecureContext", false);
  expect(voiceRoute({ browser: "online", mac: "all" }, true, "en-US")).toEqual({
    kind: "none",
    why: "insecure",
  });
  vi.unstubAllGlobals();
});

it("refreshes a newly available local engine on return to the app", async () => {
  let available = false;
  const api = {
    get: vi.fn(async () => ({ onMac: { available, englishOnly: false } })),
  } as unknown as ApiClient;
  const view = renderHook(() => useVoiceSupport(api, "en-US"));
  await waitFor(() => expect(view.result.current.support?.mac).toBeNull());
  available = true;
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(view.result.current.support?.mac).toBe("all"));
});

it("does not reuse a previous server's speech capability", async () => {
  const first = { get: async () => ({ onMac: { available: true } }) } as unknown as ApiClient;
  const second = { get: async () => ({ onMac: { available: false } }) } as unknown as ApiClient;
  const view = renderHook(({ api }) => useVoiceSupport(api, "en-US"), {
    initialProps: { api: first },
  });
  await waitFor(() => expect(view.result.current.support?.mac).toBe("all"));
  view.rerender({ api: second });
  expect(view.result.current.support).toBeNull();
  await waitFor(() => expect(view.result.current.support?.mac).toBeNull());
});
