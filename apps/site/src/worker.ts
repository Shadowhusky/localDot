export const OWNED_VIDEO =
  /^\/(demos\/[a-z0-9-]+\/(theatre(-sm)?|card-[a-z]+)|film\/localdot-film(-zh)?(-720)?)\.mp4$/;
// The most read into memory for a range when no length is known.
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
// The build's record of each owned video's length (scripts/media-lengths.mjs).
const LENGTHS = "/media-lengths.json";

type Range = RegExpMatchArray;

// The bytes a range asks for in a file of `length`, or null if none of it is there.
function span(range: Range, length: number): [number, number] | null {
  const start = range[1] ? Number(range[1]) : Math.max(0, length - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), length - 1) : length - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= length || start > end)
    return null;
  return [start, end];
}

// Bytes start to end of a stream, read only as far as end.
function slice(body: ReadableStream<Uint8Array>, start: number, end: number) {
  const reader = body.getReader();
  let at = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        const part = await reader.read();
        if (part.done) {
          controller.close();
          return;
        }
        const from = at;
        at += part.value.byteLength;
        if (at <= start) continue;
        controller.enqueue(
          part.value.subarray(
            Math.max(0, start - from),
            Math.min(part.value.byteLength, end + 1 - from),
          ),
        );
        if (at > end) {
          controller.close();
          await reader.cancel();
        }
        return;
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

/** Static Assets may return a full response for Range, and Safari needs byte ranges to play and
 * seek MP4. For the site's own recordings and film a range is cut from the stream when its length
 * is known, from the response or else the build's record, or from a bounded read when it is not;
 * no other path is touched. */
export async function videoResponse(
  request: Request,
  response: Response,
  recorded?: number,
): Promise<Response> {
  if (response.status !== 200 || request.method !== "GET" || !response.body) return response;
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
  const unsatisfiable = (length: number) => {
    headers.set("content-range", `bytes */${length}`);
    headers.set("content-length", "0");
    return new Response(null, { status: 416, headers });
  };
  const size = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
  const advertised =
    size(Number(response.headers.get("content-length") ?? Number.NaN)) ?? size(recorded);
  if (advertised !== null) {
    const bytes = span(match, advertised);
    if (!bytes) {
      await response.body.cancel();
      return unsatisfiable(advertised);
    }
    const [start, end] = bytes;
    headers.set("content-range", `bytes ${start}-${end}/${advertised}`);
    headers.set("content-length", String(end - start + 1));
    return new Response(slice(response.body, start, end), { status: 206, headers });
  }
  // Neither the binding nor the build knows the length: read the file, with a bound independent of
  // headers.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength;
    chunks.push(part.value);
    // Too large to hold: the whole file, as it streams, which a browser can still play.
    if (length > MAX_BUFFERED_BYTES) {
      const whole = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
        },
        async pull(controller) {
          const next = await reader.read();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        cancel: (reason) => reader.cancel(reason),
      });
      headers.delete("accept-ranges");
      return new Response(whole, { status: 200, headers });
    }
  }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const bytes = span(match, length);
  if (!bytes) return unsatisfiable(length);
  const [start, end] = bytes;
  headers.set("content-range", `bytes ${start}-${end}/${length}`);
  headers.set("content-length", String(end - start + 1));
  return new Response(data.slice(start, end + 1), { status: 206, headers });
}

let lengths: Promise<Record<string, number>> | undefined;

// The build's video lengths, fetched once per isolate, and again after a failed fetch.
function recordedLengths(env: Env, url: URL): Promise<Record<string, number>> {
  lengths ??= env.ASSETS.fetch(new Request(new URL(LENGTHS, url))).then((r) =>
    r.ok ? (r.json() as Promise<Record<string, number>>) : Promise.reject(),
  );
  return lengths.catch(() => {
    lengths = undefined;
    return {};
  });
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
    if (!OWNED_VIDEO.test(url.pathname)) return response;
    const recorded =
      request.headers.has("range") && !response.headers.has("content-length")
        ? (await recordedLengths(env, url))[url.pathname]
        : undefined;
    return videoResponse(request, response, recorded);
  },
} satisfies ExportedHandler<Env>;

// biome-ignore lint/style/noDefaultExport: Cloudflare requires a default module Worker entrypoint.
export default worker;
