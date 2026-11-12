import { useEffect, useState } from "react";
import { t } from "../i18n/index.ts";
import type { ApiClient } from "../lib/api.ts";
import { useLoadAgain } from "../lib/useLoadAgain.ts";
import { downloadResult } from "./file-transfer.ts";
import type { AgentStep } from "./model.ts";
import { StepPreviewCover } from "./StepPreview.tsx";
import { useRunPictureResource } from "./WorkPictures.tsx";

// Load only when a step is expanded. The saved JPEG remains available after the computer stops.
export function StepImage({
  api,
  sessionId,
  image,
}: {
  api: ApiClient;
  sessionId: string;
  image: NonNullable<AgentStep["images"]>[number];
}) {
  const key = `${sessionId}/${image.name}`;
  const [state, setState] = useState<{
    key: string;
    url?: string;
    bytes?: number;
    failed?: boolean;
  }>();
  const { attempt, failed } = useLoadAgain(key);
  // biome-ignore lint/correctness/useExhaustiveDependencies: another attempt loads it again.
  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    downloadResult(api, sessionId, image.name, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob.slice(0, blob.size, "image/jpeg"));
        setState({ key, url, bytes: blob.size });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setState({ key, failed: true });
        failed();
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, sessionId, image.name, key, attempt, failed]);
  const current = state?.key === key ? state : undefined;
  const resource = useRunPictureResource(image, sessionId, current?.bytes);
  return (
    <figure className="step-output-image step-preview-resource" aria-label={t`Image output`}>
      {current?.url ? (
        <img
          src={current.url}
          alt={image.alt}
          decoding="async"
          onError={() => {
            setState({ key, failed: true });
            failed();
          }}
        />
      ) : (
        <p role="status">{current?.failed ? t`Image preview unavailable.` : t`Loading image…`}</p>
      )}
      {current?.url && <StepPreviewCover label={t`Preview image`} resource={resource} />}
    </figure>
  );
}
