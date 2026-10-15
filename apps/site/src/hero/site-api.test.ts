import { afterEach, describe, expect, it, vi } from "vitest";
import type { DemoTimeline } from "./demo.ts";
import { siteApi } from "./site-api.ts";

const SESSION = "01M4YQGJYT4A2C2PXBQ9NCYSSM";
const previews = "/file-previews/breakout-----------------------------------/";
const demo = {
  id: "breakout",
  sessionId: SESSION,
  previews,
  api: {
    "files/01-hero.png/preview": { src: `${previews}01-hero.png.preview`, type: "image/png" },
  },
} as unknown as DemoTimeline;

afterEach(() => vi.unstubAllGlobals());

describe("siteApi", () => {
  it("serves what the demo recorded about a result, with the type the daemon gave it", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(url);
      return new Response("png-bytes");
    });
    const api = siteApi(() => demo);
    const response = await api.fetch(
      `${location.origin}/api/agent/sessions/${SESSION}/files/01-hero.png/preview?v=1`,
    );
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(await response.text()).toBe("png-bytes");
    expect(fetched).toEqual([`${previews}01-hero.png.preview`]);
  });

  it("serves the recording's frames the proof shows", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(url);
      return new Response("webp");
    });
    const frame = "01M4YQGJYT4A2C2PXBQ9NCYSSB";
    const withFrame = {
      ...demo,
      api: { [`session/thumbs/${frame}`]: { src: `${previews}thumb`, type: "image/webp" } },
    } as unknown as DemoTimeline;
    const response = await siteApi(() => withFrame).fetch(
      `/api/sessions/${SESSION}/thumbs/${frame}`,
    );
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(fetched).toEqual([`${previews}thumb`]);
  });

  it("points the app's preview links at the demo's own folder of files", async () => {
    const api = siteApi(() => demo);
    const response = await api.fetch(`/api/agent/sessions/${SESSION}/preview-link`, {
      method: "POST",
    });
    expect(await response.json()).toEqual({ base: previews });
  });

  it("has nothing for another task or anything else the app asks for", async () => {
    vi.stubGlobal("fetch", async () => new Response("x"));
    const api = siteApi(() => demo);
    const other = await api.fetch(`/api/agent/sessions/01M4YQGJYT4A2C2PXBQ9NCYSSA/proof`);
    expect(other.status).toBe(404);
    expect((await api.fetch("/api/whoami")).status).toBe(404);
  });
});
