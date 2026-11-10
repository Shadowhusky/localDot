// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpeechInstallStatus } from "../../../../packages/protocol/src/speech-install.ts";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { hearsLanguage, sizeWords, tierForLanguage } from "./speech-words.ts";
import { useSpeechInstall } from "./useSpeechInstall.ts";

const tier = (id: "light" | "balanced" | "languages", languages: string[] | null = null) => ({
  id,
  name: id,
  summary: `${id} summary`,
  credit: `${id} credit`,
  languages,
  downloadBytes: 100,
  diskBytes: 200,
  memoryBytes: 300,
  speed: "About a second",
});

const STATUS: SpeechInstallStatus = {
  supported: true,
  host: { computer: "Mac", memoryBytes: 8 * 1024 ** 3, cpus: 8, arch: "arm64" },
  tiers: [tier("light"), tier("balanced"), tier("languages")],
  recommended: "balanced",
  installed: null,
  handInstalled: null,
  using: null,
  job: null,
  freeBytes: 1024 ** 3,
};

const running: SpeechInstallStatus = {
  ...STATUS,
  job: { tier: "balanced", state: "running", stage: "model", doneBytes: 50, totalBytes: 100 },
};

function api(over: Partial<ApiClient> = {}) {
  return {
    get: vi.fn(async () => STATUS),
    post: vi.fn(async () => running),
    del: vi.fn(async () => STATUS),
    ...over,
  } as unknown as ApiClient & {
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };
}

describe("following a speech install", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("reads where things stand when it opens, and never starts anything by itself", async () => {
    const client = api();
    const view = renderHook(() => useSpeechInstall(client, false));
    await waitFor(() => expect(view.result.current.status).toEqual(STATUS));
    expect(client.get).toHaveBeenCalledWith("/api/voice/install", expect.anything());
    expect(client.post).not.toHaveBeenCalled();
  });

  it("starts only on a press, and follows it while it runs, on any device", async () => {
    const client = api();
    const view = renderHook(() => useSpeechInstall(client, false));
    await waitFor(() => expect(view.result.current.status).not.toBeNull());
    client.get.mockResolvedValue(running);
    await act(async () => {
      expect(await view.result.current.install("balanced")).toBe(true);
    });
    expect(client.post).toHaveBeenCalledWith("/api/voice/install", { tier: "balanced" });
    expect(view.result.current.status?.job?.state).toBe("running");
    const asked = client.get.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(client.get.mock.calls.length).toBeGreaterThan(asked);
  });

  it("picks up a download another device started", async () => {
    const client = api({ get: vi.fn(async () => running) as never });
    const view = renderHook(() => useSpeechInstall(client, false));
    await waitFor(() => expect(view.result.current.status?.job?.tier).toBe("balanced"));
  });

  it("stops polling once it ends, and tells the voice route to look again", async () => {
    const client = api({ get: vi.fn(async () => running) as never });
    const ended = vi.fn();
    const view = renderHook(() => useSpeechInstall(client, false, ended));
    await waitFor(() => expect(view.result.current.status?.job?.state).toBe("running"));
    client.get.mockResolvedValue(STATUS);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    await waitFor(() => expect(view.result.current.status?.job).toBeNull());
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledWith(STATUS, "balanced");
    const asked = client.get.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(client.get.mock.calls.length).toBe(asked);
  });

  it("says why a press was refused", async () => {
    const client = api({
      post: vi.fn(async () => {
        throw new ApiError(409, "Another speech model is already downloading.");
      }) as never,
    });
    const view = renderHook(() => useSpeechInstall(client, false));
    await waitFor(() => expect(view.result.current.status).not.toBeNull());
    await act(async () => {
      expect(await view.result.current.install("languages")).toBe(false);
    });
    expect(view.result.current.failure).toMatch(/already downloading/);
  });

  it("cancels and removes", async () => {
    const client = api();
    const view = renderHook(() => useSpeechInstall(client, false));
    await waitFor(() => expect(view.result.current.status).not.toBeNull());
    await act(async () => view.result.current.cancel());
    expect(client.post).toHaveBeenCalledWith("/api/voice/install/cancel");
    await act(async () => view.result.current.remove());
    expect(client.del).toHaveBeenCalledWith("/api/voice/install");
  });
});

describe("words for a speech install", () => {
  it("gives sizes people can picture", () => {
    expect(sizeWords(195 * 1024 ** 2)).toBe("195 MB");
    expect(sizeWords(1.2 * 1024 ** 3)).toBe("1.2 GB");
    expect(sizeWords(10)).toBe("1 MB");
  });

  it("knows who hears what", () => {
    const light = tier("light", ["zh", "en"]);
    expect(hearsLanguage(light, "zh-CN")).toBe(true);
    expect(hearsLanguage(light, "ja-JP")).toBe(false);
    expect(hearsLanguage(tier("languages"), "ja-JP")).toBe(true);
  });

  it("preselects what's recommended, or the lightest that hears the person's language", () => {
    const status = {
      ...STATUS,
      tiers: [tier("light", ["zh", "en"]), tier("balanced", ["zh", "en"]), tier("languages")],
    };
    expect(tierForLanguage(status, "zh-CN")).toBe("balanced");
    expect(tierForLanguage(status, "ja-JP")).toBe("languages");
    expect(tierForLanguage({ ...status, tiers: [tier("light", ["zh", "en"])] }, "fr-FR")).toBe(
      "balanced",
    );
  });
});
