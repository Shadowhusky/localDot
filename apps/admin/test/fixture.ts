import {
  countInBackground,
  platformOf,
  recordEdge,
  shouldCount,
  sourceOf,
} from "../../../packages/analytics/src/edge.ts";
import downloads from "../../../scripts/distribution/worker.ts";
import { syncDownloads } from "../src/github.ts";

// biome-ignore lint/style/noDefaultExport: Cloudflare requires a default Worker export.
export default {
  async fetch(request: Request, env: { DB: D1Database }, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/downloads/")) {
      url.pathname = url.pathname.slice("/downloads".length);
      return downloads.fetch(
        new Request(url, request),
        {
          STATS: env.DB,
          ASSETS: {
            fetch: async () =>
              new Response("signed installer bytes", {
                headers: { etag: '"original"', "cache-control": "no-store" },
              }),
          } as Fetcher,
        },
        ctx,
      );
    }
    if (url.pathname === "/sync") {
      const payload = (await request.json()) as {
        count: number;
        status?: number;
        created?: string;
      };
      const data = [
        {
          draft: false,
          tag_name: "v0.1.0-rc.39",
          published_at: payload.created ?? "2026-10-01T00:00:00Z",
          assets: [
            { id: 1, name: "localdot-0.1.0-rc.39-darwin-arm64.tgz", download_count: payload.count },
            { id: 2, name: "source.zip", download_count: 9999 },
          ],
        },
      ];
      try {
        return Response.json(
          await syncDownloads(env.DB, async () =>
            Response.json(data, { status: payload.status ?? 200 }),
          ),
        );
      } catch {
        return new Response("Sync failed", { status: 502 });
      }
    }
    if (url.pathname === "/counter") {
      const response = new Response("ok", {
        status: Number(url.searchParams.get("status") ?? 200),
      });
      const event = url.searchParams.get("event") === "page" ? "page" : "installer_shell";
      if (shouldCount(request, response, event)) await recordEdge(env.DB, request, event);
      return Response.json({
        source: sourceOf(request),
        platform: platformOf(request.headers.get("user-agent") ?? ""),
      });
    }
    if (url.pathname === "/failure") {
      const response = new Response("download bytes");
      countInBackground(ctx, env.DB, request, response, "installer_shell");
      return response;
    }
    return new Response("missing", { status: 404 });
  },
};
