import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "../i18n/index.ts";
import type { ApiClient } from "../lib/api.ts";
import { useLoadAgain } from "../lib/useLoadAgain.ts";
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

// The thumbnail widths the daemon makes (sessions/thumbs.ts THUMB_WIDTHS).
const THUMB_WIDTHS = [320, 640, 1280] as const;
export function thumbWidth(cssWidth: number | undefined, ratio = globalThis.devicePixelRatio ?? 1) {
  const wanted = (cssWidth || 160) * (ratio || 1);
  return THUMB_WIDTHS.find((width) => width >= wanted) ?? 1280;
}

// While the next picture loads the one before it stays, so moving along a timeline never blinks.
export function ReplayImage({
  api,
  sessionId,
  frameId,
  full = false,
  alt = "",
  near: told = false,
}: {
  api: ApiClient;
  sessionId: string;
  frameId: string | null;
  full?: boolean;
  alt?: string;
  // Whoever draws it already knows it is close to the view.
  near?: boolean;
}) {
  const picture = useRef<HTMLSpanElement>(null);
  const [seen, setSeen] = useState(full || typeof IntersectionObserver === "undefined");
  const near = told || seen;
  useEffect(() => {
    if (full || near || !picture.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true);
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
  // As many pixels as the place it is drawn in has on this display, so it is sharp at 2x.
  const [measured, setMeasured] = useState<number | null>(null);
  useLayoutEffect(() => {
    setMeasured(thumbWidth(picture.current?.parentElement?.getBoundingClientRect().width));
  }, []);
  const kind = full ? "frames" : "thumbs";
  const key = full
    ? `${sessionId}/frames/${frameId}?size=full`
    : `${sessionId}/thumbs/${frameId}?w=${measured}`;
  const { attempt, failed } = useLoadAgain(key);
  // biome-ignore lint/correctness/useExhaustiveDependencies: another attempt loads it again.
  useEffect(() => {
    if (!frameId || !near || (!full && measured === null)) return;
    const controller = new AbortController();
    void load(api, kind, key, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        if (!blob) failed();
        const url = blob && URL.createObjectURL(blob);
        if (shown.current) URL.revokeObjectURL(shown.current);
        shown.current = url;
        setImage(url ? { sessionId, url } : null);
      })
      .catch(() => {
        if (!controller.signal.aborted) failed();
      });
    return () => controller.abort();
  }, [api, kind, key, sessionId, frameId, near, attempt, failed]);
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
      aria-label={alt || t`No screenshot`}
    />
  );
}
