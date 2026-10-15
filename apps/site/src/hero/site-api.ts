import { disposition } from "@app/agent/file-transfer.ts";
import { createApi } from "@app/lib/api.ts";
import type { DemoTimeline } from "./demo.ts";

// A task's results and its recording's frames, as the app asks for them.
const TASK = /\/api\/(agent\/)?sessions\/([0-9A-Z]{26})\/(.+?)(?:\?.*)?$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A bundle keeps each result file as its newest version: a download of that version is the file.
async function newestVersion(demo: DemoTimeline, path: string) {
  const asked = /^files\/([^/]+)\/versions\/(\d+)$/.exec(path);
  const list = asked && demo.api[`files/${asked[1]}/versions`];
  if (!asked || !list) return undefined;
  const response = await fetch(list.src);
  if (!response.ok) return undefined;
  const { versions } = (await response.json()) as { versions: { version: number }[] };
  const newest = Math.max(...versions.map((v) => v.version));
  return Number(asked[2]) === newest ? demo.api[`files/${asked[1]}`] : undefined;
}

// The app's API client for the website: there is no daemon behind it, only what the demo on show
// recorded about its results, served from its bundle with the types the daemon gave them.
export function siteApi(current: () => DemoTimeline | null) {
  return createApi("", {
    fetchImpl: async (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        location.href,
      );
      const demo = current();
      const match = TASK.exec(url.pathname);
      if (!match) {
        // A file the viewer loads from its preview link is a plain file of the site.
        if (demo && url.origin === location.origin && url.pathname.startsWith(demo.previews))
          return fetch(url.pathname);
        return json({ error: "Not on the website." }, 404);
      }
      if (!demo || match[2] !== demo.sessionId) return json({ error: "Not on the website." }, 404);
      const path = `${match[1] ? "" : "session/"}${match[3] ?? ""}`;
      if (path === "preview-link" && init?.method === "POST") return json({ base: demo.previews });
      // A spreadsheet's table comes a sheet at a time.
      const key = path.endsWith("/table")
        ? `${path}?sheet=${url.searchParams.get("sheet") ?? 0}`
        : path;
      const saved = demo.api[key] ?? (await newestVersion(demo, path));
      if (!saved) {
        if (import.meta.env.DEV) console.debug("site api: nothing for", url.pathname);
        return json({ error: "Not on the website." }, 404);
      }
      const response = await fetch(saved.src);
      if (!response.ok) return json({ error: "Not on the website." }, 404);
      const headers: Record<string, string> = { "content-type": saved.type };
      // A result file downloads as the daemon hands one over: an attachment under its own name.
      const file = /^files\/([^/]+)(?:\/versions\/\d+)?$/.exec(path)?.[1];
      if (file && saved.type === "application/octet-stream") {
        headers["content-disposition"] = disposition(decodeURIComponent(file));
        headers["x-content-type-options"] = "nosniff";
      }
      return new Response(response.body, { status: 200, headers });
    },
  });
}
