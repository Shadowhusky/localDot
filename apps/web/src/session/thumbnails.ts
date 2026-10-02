import type { ApiClient } from "../lib/api.ts";

type CachedFrame = { promise: Promise<string>; references: number; url?: string };
const caches = new WeakMap<ApiClient, Map<string, CachedFrame>>();

// An <img> cannot send the install token. Scope authenticated blob URLs to their API client,
// and keep them only while a row displays the frame.
export function thumbnailUrl(api: ApiClient, sessionId: string, frameId: string): Promise<string> {
  let cache = caches.get(api);
  if (!cache) {
    cache = new Map();
    caches.set(api, cache);
  }
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
      if (entry.references === 0) URL.revokeObjectURL(url);
      return url;
    });
  cache.set(key, entry);
  void entry.promise.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });
  return entry.promise;
}

export function releaseThumbnail(api: ApiClient, sessionId: string, frameId: string): void {
  const cache = caches.get(api);
  const key = `${sessionId}/${frameId}`;
  const entry = cache?.get(key);
  if (!entry || --entry.references > 0) return;
  if (entry.url) URL.revokeObjectURL(entry.url);
  cache?.delete(key);
}
