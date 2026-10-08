import type { ApiClient } from "../lib/api.ts";

type CachedFrame = { promise: Promise<string>; references: number; url?: string };
const caches = new WeakMap<ApiClient, Map<string, CachedFrame>>();
// Frames no row shows any more stay decoded for a while, so a row that remounts (a reopened group,
// a filter switched back) paints its picture in its first frame instead of a blank one.
export const IDLE_FRAMES = 64;

function cacheOf(api: ApiClient): Map<string, CachedFrame> {
  let cache = caches.get(api);
  if (!cache) {
    cache = new Map();
    caches.set(api, cache);
  }
  return cache;
}

async function decoded(url: string): Promise<string> {
  if (typeof Image === "undefined") return url;
  const image = new Image();
  image.src = url;
  if (typeof image.decode === "function") await image.decode().catch(() => {});
  return url;
}

// An <img> cannot send the install token. Scope authenticated blob URLs to their API client.
export function thumbnailUrl(api: ApiClient, sessionId: string, frameId: string): Promise<string> {
  const cache = cacheOf(api);
  const key = `${sessionId}/${frameId}`;
  const existing = cache.get(key);
  if (existing) {
    existing.references++;
    return existing.promise;
  }
  const entry: CachedFrame = { references: 1, promise: Promise.resolve("") };
  entry.promise = api
    .fetch(
      `${api.socketUrl("").replace(/^ws/, "http")}/api/sessions/${sessionId}/frames/${frameId}`,
      { headers: { authorization: api.authorization() }, signal: AbortSignal.timeout(15_000) },
    )
    .then(async (res) => {
      if (!res.ok) throw new Error(`frame ${frameId}: ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      entry.url = url;
      return decoded(url);
    });
  cache.set(key, entry);
  void entry.promise.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });
  return entry.promise;
}

// A loaded frame's URL at once, or undefined while it loads or when it was never asked for.
export function cachedThumbnail(
  api: ApiClient,
  sessionId: string,
  frameId: string,
): string | undefined {
  return caches.get(api)?.get(`${sessionId}/${frameId}`)?.url;
}

export function releaseThumbnail(api: ApiClient, sessionId: string, frameId: string): void {
  const cache = caches.get(api);
  const key = `${sessionId}/${frameId}`;
  const entry = cache?.get(key);
  if (!cache || !entry || --entry.references > 0) return;
  cache.delete(key);
  cache.set(key, entry);
  let idle = 0;
  for (const frame of cache.values()) if (frame.references === 0) idle++;
  for (const [name, frame] of cache) {
    if (idle <= IDLE_FRAMES) break;
    if (frame.references > 0) continue;
    if (frame.url) URL.revokeObjectURL(frame.url);
    cache.delete(name);
    idle--;
  }
}
