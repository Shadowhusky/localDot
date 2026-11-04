import { countInBackground } from "../../packages/analytics/src/edge.ts";

// biome-ignore lint/style/noDefaultExport: Cloudflare requires a default Worker export.
export default {
  async fetch(
    request: Request,
    env: { ASSETS: Fetcher; STATS?: D1Database },
    ctx: ExecutionContext,
  ) {
    const response = await env.ASSETS.fetch(request);
    const path = new URL(request.url).pathname;
    if (path === "/install.sh" || path === "/install.ps1") {
      countInBackground(
        ctx,
        env.STATS,
        request,
        response,
        path.endsWith(".ps1") ? "installer_windows" : "installer_shell",
      );
    }
    return response;
  },
};
