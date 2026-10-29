import { describe, expect, it } from "vitest";
import {
  PreviewRequest,
  PreviewsStatus,
  parsePreviewPreface,
  previewPreface,
  previewTarget,
} from "./previews.ts";

const TOKEN = "t".repeat(43);

describe("which addresses name a server in dot's computer", () => {
  it("takes localhost, its subdomains, loopback and the any-addresses on any port", () => {
    expect(previewTarget("http://localhost:5173/")).toEqual({
      scheme: "http",
      host: "localhost:5173",
      dial: "localhost:5173",
      port: 5173,
      path: "/",
    });
    expect(previewTarget("https://thema.localhost:1355/app?tab=2#top")).toEqual({
      scheme: "https",
      host: "thema.localhost:1355",
      dial: "thema.localhost:1355",
      port: 1355,
      path: "/app?tab=2",
    });
    expect(previewTarget("http://127.0.0.1:8000")?.dial).toBe("127.0.0.1:8000");
    expect(previewTarget("http://[::1]:4173/x")?.dial).toBe("[::1]:4173");
    expect(previewTarget("http://LOCALHOST:3000/")?.host).toBe("localhost:3000");
    expect(previewTarget("http://localhost/")).toMatchObject({ port: 80, host: "localhost" });
    expect(previewTarget("https://localhost/")).toMatchObject({ port: 443, host: "localhost" });
  });

  it("sends servers that listen everywhere a loopback name", () => {
    expect(previewTarget("http://0.0.0.0:8000/docs")).toEqual({
      scheme: "http",
      host: "localhost:8000",
      dial: "localhost:8000",
      port: 8000,
      path: "/docs",
    });
    expect(previewTarget("http://[::]:3000/")?.dial).toBe("localhost:3000");
  });

  it("takes the computer's own network address only when it is the computer's", () => {
    expect(previewTarget("http://172.20.0.11:5173/", ["172.20.0.11"])).toMatchObject({
      host: "172.20.0.11:5173",
      dial: "172.20.0.11:5173",
    });
    expect(previewTarget("http://172.20.0.11:5173/")).toBeUndefined();
    expect(previewTarget("http://192.168.1.4:5173/", ["172.20.0.11"])).toBeUndefined();
  });

  it("refuses everything else", () => {
    for (const address of [
      "http://example.com/",
      "http://localhost.example.com:3000/",
      "http://localhost.:3000/",
      "http://user:pw@localhost:3000/",
      "ftp://localhost/",
      "javascript:alert(1)",
      "http://127.0.0.2:3000/",
      "http://10.0.0.1/",
      "not a url",
      `http://localhost/${"a".repeat(2048)}`,
    ])
      expect(previewTarget(address), address).toBeUndefined();
  });
});

describe("the forwarder's first line", () => {
  it("round-trips an open and a listing", () => {
    expect(previewPreface(TOKEN, { open: "localhost:5173" })).toBe(
      `LOCALDOT-PREVIEW/1 ${TOKEN} OPEN localhost:5173\n`,
    );
    expect(parsePreviewPreface(`LOCALDOT-PREVIEW/1 ${TOKEN} OPEN [::1]:4173`)).toEqual({
      token: TOKEN,
      command: { open: "[::1]:4173" },
    });
    expect(parsePreviewPreface(previewPreface(TOKEN, { list: true }).trim())).toEqual({
      token: TOKEN,
      command: { list: true },
    });
  });

  it("refuses anything that isn't exactly one well-formed command", () => {
    for (const line of [
      "",
      `LOCALDOT-PREVIEW/2 ${TOKEN} LIST`,
      `LOCALDOT-PREVIEW/1 ${TOKEN} LIST extra`,
      `LOCALDOT-PREVIEW/1 ${TOKEN} OPEN localhost`,
      `LOCALDOT-PREVIEW/1 ${TOKEN} OPEN localhost:0`,
      `LOCALDOT-PREVIEW/1 ${TOKEN} OPEN localhost:65536`,
      `LOCALDOT-PREVIEW/1 ${TOKEN} OPEN [::2]:80`,
      `LOCALDOT-PREVIEW/1 ${TOKEN} OPEN user@localhost:80`,
      `LOCALDOT-PREVIEW/1 ${TOKEN} CONNECT localhost:80`,
      "LOCALDOT-PREVIEW/1  LIST",
    ])
      expect(parsePreviewPreface(line), line).toBeUndefined();
  });
});

describe("the previews API", () => {
  it("takes an address dot printed or a listening server's port, and nothing more", () => {
    expect(PreviewRequest.safeParse({ url: "http://localhost:5173/" }).success).toBe(true);
    expect(PreviewRequest.safeParse({ port: 5173 }).success).toBe(true);
    expect(PreviewRequest.safeParse({ port: 0 }).success).toBe(false);
    expect(PreviewRequest.safeParse({ url: "http://localhost/", port: 80 }).success).toBe(false);
    expect(PreviewRequest.safeParse({ url: "" }).success).toBe(false);
  });

  it("describes what can be opened", () => {
    expect(
      PreviewsStatus.parse({
        state: "needs-update",
        message: "Update your computer to open previews.",
        addresses: [],
        previews: [],
        servers: [{ port: 5173, url: "http://localhost:5173/", name: "node" }],
      }).state,
    ).toBe("needs-update");
    expect(
      PreviewsStatus.safeParse({ state: "open", addresses: [], previews: [], servers: [] }).success,
    ).toBe(false);
  });
});
