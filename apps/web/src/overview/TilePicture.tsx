import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { replayOrigin } from "../replay/useReplay.ts";
import type { PictureWidth } from "./overview-model.ts";

// Pictures recently shown stay as blobs, so a tile that comes back into view, changes size or is let
// go after its sharper picture paints at once. A screenshot weighs as much as a dozen thumbnails.
const KEPT = 96;
const blobs = new WeakMap<ApiClient, Map<string, Blob>>();

function keptBy(api: ApiClient): Map<string, Blob> {
  let kept = blobs.get(api);
  if (!kept) {
    kept = new Map();
    blobs.set(api, kept);
  }
  return kept;
}

const pathOf = (sessionId: string, frameId: string, width: PictureWidth) =>
  width === "full"
    ? `/api/sessions/${sessionId}/frames/${frameId}`
    : `/api/sessions/${sessionId}/thumbs/${frameId}${width === 320 ? "" : `?w=${width}`}`;

export function heldPicture(
  api: ApiClient,
  sessionId: string,
  frameId: string,
  width: PictureWidth,
): Blob | undefined {
  return blobs.get(api)?.get(pathOf(sessionId, frameId, width));
}

async function load(api: ApiClient, path: string, signal: AbortSignal): Promise<Blob | null> {
  const kept = keptBy(api);
  const held = kept.get(path);
  if (held) {
    kept.delete(path);
    kept.set(path, held);
    return held;
  }
  const response = await api.fetch(`${replayOrigin(api)}${path}`, {
    headers: { authorization: api.authorization() },
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (response.status === 401) api.rejectUnauthorized?.();
  if (!response.ok) return null;
  const blob = await response.blob();
  kept.set(path, blob);
  for (const old of kept.keys()) {
    if (kept.size <= KEPT) break;
    kept.delete(old);
  }
  return blob;
}

async function decoded(url: string): Promise<void> {
  const image = new Image();
  image.src = url;
  await image.decode().catch(() => {});
}

// A task's latest screenshot at the width its tile needs. The picture on show stays until the next
// is decoded, so a tile never blinks as dot moves on; one that has no screenshot yet shows nothing.
// Nothing is asked for while `active` is off: a tile out of view or a hidden page loads nothing.
export function TilePicture({
  api,
  sessionId,
  frameId,
  width,
  active,
}: {
  api: ApiClient;
  sessionId: string;
  frameId: string | undefined;
  width: PictureWidth;
  active: boolean;
}) {
  const [shown, setShown] = useState<{ key: string; url: string } | null>(null);
  const url = useRef<string | null>(null);
  const key = frameId ? pathOf(sessionId, frameId, width) : null;
  useEffect(() => {
    if (!key || !active || shown?.key === key) return;
    const controller = new AbortController();
    void load(api, key, controller.signal)
      .then(async (blob) => {
        if (!blob || controller.signal.aborted) return;
        const next = URL.createObjectURL(blob);
        await decoded(next);
        if (controller.signal.aborted) {
          URL.revokeObjectURL(next);
          return;
        }
        if (url.current) URL.revokeObjectURL(url.current);
        url.current = next;
        setShown({ key, url: next });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [api, key, active, shown?.key]);
  useEffect(
    () => () => {
      if (url.current) URL.revokeObjectURL(url.current);
    },
    [],
  );
  return shown ? (
    <img className="overview-picture-image" src={shown.url} alt="" draggable={false} />
  ) : null;
}
