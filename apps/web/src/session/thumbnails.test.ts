import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { cachedThumbnail, IDLE_FRAMES, releaseThumbnail, thumbnailUrl } from "./thumbnails.ts";

afterEach(() => vi.unstubAllGlobals());

function frames(fetchImpl: typeof fetch = async () => new Response(new Blob(["frame"]))) {
  let made = 0;
  const revoked: string[] = [];
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: () => `blob:frame-${++made}`,
    revokeObjectURL: (url: string) => revoked.push(url),
  });
  const api = createApi("thumbs", { origin: "http://localhost", fetchImpl });
  return { api, revoked };
}

describe("step thumbnails", () => {
  it("keeps a released frame decoded, so a row that comes back shows it in its first frame", async () => {
    const { api, revoked } = frames();
    expect(cachedThumbnail(api, "s", "f1")).toBeUndefined();
    const url = await thumbnailUrl(api, "s", "f1");
    releaseThumbnail(api, "s", "f1");
    expect(revoked).toEqual([]);
    expect(cachedThumbnail(api, "s", "f1")).toBe(url);
    expect(await thumbnailUrl(api, "s", "f1")).toBe(url);
  });

  it("lets only the oldest unused frames go once more than the idle allowance are kept", async () => {
    const { api, revoked } = frames();
    const held = await thumbnailUrl(api, "s", "held");
    for (let n = 0; n <= IDLE_FRAMES; n++) {
      await thumbnailUrl(api, "s", `f${n}`);
      releaseThumbnail(api, "s", `f${n}`);
    }
    expect(revoked).toEqual(["blob:frame-2"]);
    expect(cachedThumbnail(api, "s", "f0")).toBeUndefined();
    expect(cachedThumbnail(api, "s", "held")).toBe(held);
    expect(cachedThumbnail(api, "s", `f${IDLE_FRAMES}`)).toBeDefined();
  });

  it("lets go of a frame dropped while it was still loading", async () => {
    let arrive = () => {};
    const slow = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const { api, revoked } = frames(async (input) => {
      if (String(input).endsWith("/slow")) await slow;
      return new Response(new Blob(["frame"]));
    });
    const loading = thumbnailUrl(api, "s", "slow");
    releaseThumbnail(api, "s", "slow");
    for (let n = 0; n <= IDLE_FRAMES; n++) {
      await thumbnailUrl(api, "s", `f${n}`);
      releaseThumbnail(api, "s", `f${n}`);
    }
    arrive();
    await expect(loading).rejects.toThrow();
    expect(revoked).toContain(`blob:frame-${IDLE_FRAMES + 2}`);
    expect(cachedThumbnail(api, "s", "slow")).toBeUndefined();
  });
});
