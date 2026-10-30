import { computerFileName } from "@localdot/protocol";
import { type RefObject, useEffect, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { loadThumbnail } from "./api.ts";
import { slot } from "./usePreview.ts";
import type { ComputerEntry } from "./viewer/scope.tsx";

// Thumbnails the thread has shown, kept while the page is open so a row scrolled back into the
// thread's window draws at once; the oldest are let go past this many.
const KEPT = 64;
const kept = new Map<string, string>();
function keep(key: string, url: string) {
  kept.set(key, url);
  for (const [old, oldUrl] of kept) {
    if (kept.size <= KEPT) break;
    kept.delete(old);
    URL.revokeObjectURL(oldUrl);
  }
}

// A picture on the computer as a small, metadata-free PNG, loaded once its element is near the
// viewport, two at a time across the page. Null while loading or when it can't be read.
export function useThumbnail(
  api: ApiClient | null,
  entry: ComputerEntry | undefined,
  target: RefObject<Element | null>,
): string | null {
  const key = entry ? `${entry.sessionId}/${entry.path}` : "";
  const [url, setUrl] = useState<{ key: string; url: string } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key names the file.
  useEffect(() => {
    if (!api || !entry) return;
    const known = kept.get(key);
    if (known) {
      setUrl({ key, url: known });
      return;
    }
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const load = async () => {
      release = await slot(controller.signal);
      const name = computerFileName(entry.path);
      const blob = await loadThumbnail(
        api,
        { sessionId: entry.sessionId, name, path: entry.path },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const made = URL.createObjectURL(blob);
      keep(key, made);
      setUrl({ key, url: made });
    };
    const start = () =>
      load()
        .catch(() => {})
        .finally(() => release?.());
    const observer =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver(
            (entries) => {
              if (!entries.some((seen) => seen.isIntersecting)) return;
              observer?.disconnect();
              void start();
            },
            { rootMargin: "200px" },
          );
    if (!observer) void start();
    else if (target.current) observer.observe(target.current);
    return () => {
      observer?.disconnect();
      controller.abort();
      release?.();
    };
  }, [api, key, target]);
  return url?.key === key ? url.url : null;
}
