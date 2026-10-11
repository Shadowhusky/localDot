const DEMO_VIDEO = /^\/demos\/(work|research|play)(-mobile)?\.mp4$/;
const MAX_DEMO_BYTES = 4 * 1024 * 1024;

/** Static Assets may return a full response for Range. These six small, owned clips
 * need byte ranges for Safari and seeking; never buffer arbitrary paths or large assets. */
export async function demoResponse(request: Request, response: Response): Promise<Response> {
  if (response.status !== 200 || request.method !== "GET") return response;
  const length = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_DEMO_BYTES) return response;
  const headers = new Headers(response.headers);
  headers.set("accept-ranges", "bytes");
  const range = request.headers.get("range");
  const ifRange = request.headers.get("if-range");
  const current = response.headers.get("etag");
  const matches =
    !ifRange ||
    (!ifRange.startsWith("W/") && ifRange === current) ||
    ifRange === response.headers.get("last-modified");
  const match = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (!matches || !match || (!match[1] && !match[2]))
    return new Response(response.body, { status: 200, headers });
  const start = match[1] ? Number(match[1]) : Math.max(0, length - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), length - 1) : length - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start >= length ||
    start > end
  ) {
    await response.body?.cancel();
    headers.set("content-range", `bytes */${length}`);
    headers.set("content-length", "0");
    return new Response(null, { status: 416, headers });
  }
  const data = await response.arrayBuffer();
  if (data.byteLength !== length) return new Response(data, { status: 200, headers });
  headers.set("content-range", `bytes ${start}-${end}/${length}`);
  headers.set("content-length", String(end - start + 1));
  return new Response(data.slice(start, end + 1), { status: 206, headers });
}

export const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (
      url.hostname === "www.localdot.dev" ||
      (url.hostname === "localdot.dev" && url.protocol !== "https:")
    ) {
      url.protocol = "https:";
      url.hostname = "localdot.dev";
      url.port = "";
      return Response.redirect(url.href, 308);
    }
    const response = await env.ASSETS.fetch(request);
    return DEMO_VIDEO.test(url.pathname) ? demoResponse(request, response) : response;
  },
} satisfies ExportedHandler<Env>;

// biome-ignore lint/style/noDefaultExport: Cloudflare requires a default module Worker entrypoint.
export default worker;
