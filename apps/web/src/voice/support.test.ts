// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../lib/api.ts";
import { browserSpeech, macSpeech, voiceRoute } from "./support.ts";
import { routeBlocked, routeLabel } from "./words.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("where speech becomes text", () => {
  it("prefers this device, then the user's computer, and goes online only when allowed", () => {
    expect(voiceRoute({ browser: "local", mac: "all" }, false, "en-US")).toEqual({
      kind: "device",
    });
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
    expect(routeBlocked({ kind: "none", why: "checking" })).toBeUndefined();
    expect(routeBlocked({ kind: "none", why: "download" })).toBeUndefined();
    expect(routeBlocked({ kind: "none", why: "unsupported" })).toBe(
      "This browser can't turn speech into text.",
    );
  });

  it("asks the browser for speech on this device only", async () => {
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
