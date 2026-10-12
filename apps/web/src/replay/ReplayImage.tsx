import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { replayOrigin } from "./useReplay.ts";

// Recently shown pictures stay as blobs, so a scrubber moving back over them paints at once. A full
// frame weighs as much as dozens of thumbnails, so only a few of those stay.
const KEPT = { thumbs: 64, frames: 8 } as const;
type Kind = keyof typeof KEPT;
const kept = new WeakMap<ApiClient, Record<Kind, Map<string, Blob>>>();

function keptBy(api: ApiClient, kind: Kind): Map<string, Blob> {
  let blobs = kept.get(api);
  if (!blobs) {
    blobs = { thumbs: new Map(), frames: new Map() };
    kept.set(api, blobs);
  }
  return blobs[kind];
}

async function load(
  api: ApiClient,
  kind: Kind,
  key: string,
  signal: AbortSignal,
): Promise<Blob | null> {
  const blobs = keptBy(api, kind);
  const held = blobs.get(key);
  if (!held) {
    const response = await api.fetch(`${replayOrigin(api)}/api/sessions/${key}`, {
      headers: { authorization: api.authorization() },
      credentials: "same-origin",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (response.status === 401) api.rejectUnauthorized?.();
    if (!response.ok) return null;
    const blob = await response.blob();
    blobs.set(key, blob);
    for (const old of blobs.keys()) {
      if (blobs.size <= KEPT[kind]) break;
      blobs.delete(old);
    }
    return blob;
  }
  blobs.delete(key);
  blobs.set(key, held);
  return held;
}

// While the next picture loads the one before it stays, so moving along a timeline never blinks.
export function ReplayImage({
  api,
  sessionId,
  frameId,
  full = false,
  alt = "",
}: {
  api: ApiClient;
  sessionId: string;
  frameId: string | null;
  full?: boolean;
  alt?: string;
}) {
  const picture = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(full || typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (full || near || !picture.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "400px" },
    );
    observer.observe(picture.current);
    return () => observer.disconnect();
  }, [full, near]);
  const [image, setImage] = useState<{ sessionId: string; url: string } | null>(null);
  const shown = useRef<string | null>(null);
  const kind = full ? "frames" : "thumbs";
  const key = `${sessionId}/${kind}/${frameId}`;
  useEffect(() => {
    if (!frameId || !near) return;
    const controller = new AbortController();
    void load(api, kind, key, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        const url = blob && URL.createObjectURL(blob);
        if (shown.current) URL.revokeObjectURL(shown.current);
        shown.current = url;
        setImage(url ? { sessionId, url } : null);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [api, kind, key, sessionId, frameId, near]);
  useEffect(
    () => () => {
      if (shown.current) URL.revokeObjectURL(shown.current);
    },
    [],
  );
  return frameId && image?.sessionId === sessionId ? (
    <img src={image.url} alt={alt} draggable={false} />
  ) : (
    <span
      ref={picture}
      className="replay-image-empty"
      role="img"
      aria-label={alt || "No screenshot"}
    />
  );
}
