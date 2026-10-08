import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { replayOrigin } from "./useReplay.ts";

// Recently shown pictures stay as blobs, so a scrubber moving back over them paints at once.
const KEPT = 64;
const kept = new WeakMap<ApiClient, Map<string, Blob>>();

function keptBy(api: ApiClient): Map<string, Blob> {
  let blobs = kept.get(api);
  if (!blobs) {
    blobs = new Map();
    kept.set(api, blobs);
  }
  return blobs;
}

async function load(api: ApiClient, key: string, signal: AbortSignal): Promise<Blob | null> {
  const blobs = keptBy(api);
  const held = blobs.get(key);
  if (!held) {
    const response = await api.fetch(`${replayOrigin(api)}/api/sessions/${key}`, {
      headers: { authorization: api.authorization() },
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (response.status === 401) api.rejectUnauthorized?.();
    if (!response.ok) return null;
    const blob = await response.blob();
    blobs.set(key, blob);
    for (const old of blobs.keys()) {
      if (blobs.size <= KEPT) break;
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
  const [image, setImage] = useState<{ sessionId: string; url: string } | null>(null);
  const shown = useRef<string | null>(null);
  const key = `${sessionId}/${full ? "frames" : "thumbs"}/${frameId}`;
  useEffect(() => {
    if (!frameId) return;
    const controller = new AbortController();
    void load(api, key, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        const url = blob && URL.createObjectURL(blob);
        if (shown.current) URL.revokeObjectURL(shown.current);
        shown.current = url;
        setImage(url ? { sessionId, url } : null);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [api, key, sessionId, frameId]);
  useEffect(
    () => () => {
      if (shown.current) URL.revokeObjectURL(shown.current);
    },
    [],
  );
  return frameId && image?.sessionId === sessionId ? (
    <img src={image.url} alt={alt} draggable={false} />
  ) : (
    <span className="replay-image-empty" role="img" aria-label={alt || "No screenshot"} />
  );
}
