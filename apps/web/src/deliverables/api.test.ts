// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import {
  downloadComputerFile,
  isLoopbackPage,
  loadComputerFile,
  loadPreview,
  openOnMac,
  previewUrl,
} from "./api.ts";

const ID = "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N";
const api = (respond: (url: string, init: RequestInit) => Response) => {
  const calls: [string, RequestInit][] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push([String(url), init ?? {}]);
    return respond(String(url), init ?? {});
  }) as unknown as typeof fetch;
  return {
    client: createApi("a".repeat(43), { fetchImpl, origin: "http://127.0.0.1:4750" }),
    calls,
  };
};
describe("deliverables api", () => {
  it("loads a page image as a blob and a text excerpt as parsed JSON", async () => {
    const png = api(
      () =>
        new Response(new Uint8Array([137, 80]), {
          headers: { "content-type": "image/png", "x-localdot-preview": "computer" },
        }),
    );
    const image = await loadPreview(png.client, ID, "report.ods", 2, new AbortController().signal);
    expect(image.kind === "image" && image.madeBy).toBe("computer");
    expect(png.calls[0]?.[0]).toBe(
      `http://127.0.0.1:4750/api/agent/sessions/${ID}/files/report.ods/preview?v=2`,
    );
    const text = api(() => Response.json({ kind: "table", rows: [["a", "b"]], truncated: false }));
    expect(await loadPreview(text.client, ID, "a.csv", null, new AbortController().signal)).toEqual(
      {
        kind: "table",
        rows: [["a", "b"]],
        truncated: false,
      },
    );
  });
  it("refuses a preview that is not a png or JSON, or is larger than its cap", async () => {
    const svg = api(() => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }));
    await expect(
      loadPreview(svg.client, ID, "a.png", 1, new AbortController().signal),
    ).rejects.toThrow();
    const huge = api(
      () =>
        new Response(new Uint8Array(3 * 1024 * 1024), { headers: { "content-type": "image/png" } }),
    );
    await expect(
      loadPreview(huge.client, ID, "a.png", 1, new AbortController().signal),
    ).rejects.toThrow();
  });
  it("never builds a request for an unsafe file name", async () => {
    const any = api(() => new Response(null));
    await expect(
      loadPreview(any.client, ID, "../x", 1, new AbortController().signal),
    ).rejects.toThrow();
    expect(any.calls).toEqual([]);
  });
  it("posts the version to open and returns where the file went", async () => {
    const mac = api(() =>
      Response.json({ path: "~/Downloads/localDot/T (abc123)/a.pdf", reused: false }),
    );
    expect((await openOnMac(mac.client, ID, "a.pdf", 1)).path).toMatch(/^~\/Downloads\/localDot\//);
    expect(mac.calls[0]?.[1].body).toBe(JSON.stringify({ version: 1 }));
  });
  it("offers Open on Mac only on a loopback page", () => {
    expect(isLoopbackPage({ protocol: "http:", hostname: "127.0.0.1" })).toBe(true);
    expect(isLoopbackPage({ protocol: "http:", hostname: "localhost" })).toBe(true);
    expect(isLoopbackPage({ protocol: "https:", hostname: "mac.tailnet.example" })).toBe(false);
  });
  it("reads a computer file only by its task and a path under the home folder", async () => {
    const about = api(() => Response.json({ kind: "file", path: "~/a b.txt", bytes: 3 }));
    const file = { sessionId: ID, name: "a b.txt", path: "~/a b.txt" };
    expect((await loadComputerFile(about.client, file, new AbortController().signal)).kind).toBe(
      "file",
    );
    expect(about.calls[0]?.[0]).toBe(
      `http://127.0.0.1:4750/api/agent/sessions/${ID}/computer-files/about?path=%7E%2Fa+b.txt`,
    );
    expect(previewUrl(about.client, "/file-previews/t/", file)).toBe(
      "http://127.0.0.1:4750/file-previews/t/computer/a%20b.txt?path=%7E%2Fa+b.txt",
    );
    for (const path of ["/etc/passwd", "~/../etc/passwd", "~/a/../../b"]) {
      const any = api(() => new Response(null));
      await expect(
        loadComputerFile(any.client, { ...file, path }, new AbortController().signal),
      ).rejects.toThrow();
      expect(any.calls).toEqual([]);
    }
  });
  it("refuses a computer download that isn't an inert attachment of that file", async () => {
    const file = { sessionId: ID, name: "page.html", path: "~/page.html" };
    const served = (headers: Record<string, string>) =>
      api(() => new Response("<script>x</script>", { headers }));
    const inert = {
      "content-type": "application/octet-stream",
      "content-disposition": "attachment; filename*=UTF-8''page.html",
      "x-content-type-options": "nosniff",
    };
    const ok = served(inert);
    expect((await downloadComputerFile(ok.client, file, new AbortController().signal)).type).toBe(
      "application/octet-stream",
    );
    for (const changed of [
      { "content-type": "text/html" },
      { "content-disposition": "inline" },
      { "x-content-type-options": "" },
    ]) {
      const bad = served({ ...inert, ...changed });
      await expect(
        downloadComputerFile(bad.client, file, new AbortController().signal),
      ).rejects.toThrow();
    }
  });
});
