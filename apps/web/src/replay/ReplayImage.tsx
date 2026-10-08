import { useEffect, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { replayOrigin } from "./useReplay.ts";

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
  const [image, setImage] = useState<{ key: string; url: string } | null>(null);
  const key = `${sessionId}/${full ? "frames" : "thumbs"}/${frameId}`;
  useEffect(() => {
    if (!frameId) return;
    const controller = new AbortController();
    let ownedUrl: string | undefined;
    void api
      .fetch(`${replayOrigin(api)}/api/sessions/${key}`, {
        headers: { authorization: api.authorization() },
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      })
      .then(async (response) => {
        if (response.status === 401) api.rejectUnauthorized?.();
        if (!response.ok) return;
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        ownedUrl = URL.createObjectURL(blob);
        setImage({ key, url: ownedUrl });
      })
      .catch(() => {});
    return () => {
      controller.abort();
      if (ownedUrl) URL.revokeObjectURL(ownedUrl);
    };
  }, [api, key, frameId]);
  return image?.key === key ? (
    <img src={image.url} alt={alt} draggable={false} />
  ) : (
    <span className="replay-image-empty" role="img" aria-label={alt || "No screenshot"} />
  );
}
