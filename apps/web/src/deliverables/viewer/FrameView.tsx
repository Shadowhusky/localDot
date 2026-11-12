import { useEffect, useState } from "react";
import { t } from "../../i18n/index.ts";
import type { ApiClient } from "../../lib/api.ts";
import { releaseThumbnail, thumbnailUrl } from "../../session/thumbnails.ts";
import { PictureView } from "./PictureView.tsx";
import type { FrameEntry } from "./scope.tsx";
import { ViewerLoading, ViewerMessage } from "./states.tsx";

// A screenshot a task recorded, large and zoomable as any picture.
export function FrameView({ api, frame }: { api: ApiClient; frame: FrameEntry }) {
  const { sessionId, frameId, name } = frame;
  const key = `${sessionId}/${frameId}`;
  const [state, setState] = useState<{ key: string; url?: string }>();
  useEffect(() => {
    let disposed = false;
    thumbnailUrl(api, sessionId, frameId).then(
      (url) => {
        if (!disposed) setState({ key, url });
      },
      () => {
        if (!disposed) setState({ key });
      },
    );
    return () => {
      disposed = true;
      releaseThumbnail(api, sessionId, frameId);
    };
  }, [api, sessionId, frameId, key]);
  if (state?.key !== key) return <ViewerLoading label={t`Loading screenshot`} />;
  return state.url ? (
    <PictureView key={key} src={state.url} name={name} />
  ) : (
    <ViewerMessage name={name} title={t`Screenshot unavailable`} />
  );
}
