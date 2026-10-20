import { useEffect, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { downloadResult } from "./file-transfer.ts";
import type { AgentStep } from "./model.ts";
import { StepPreviewButton } from "./StepPreview.tsx";

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
        if (!controller.signal.aborted) setState({ key, failed: true });
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, sessionId, image.name, key]);
  const current = state?.key === key ? state : undefined;
  return (
    <figure className="step-output-image step-preview-resource" aria-label="Image output">
      {current?.url ? (
        <img
          src={current.url}
          alt={image.alt}
          decoding="async"
          onError={() => setState({ key, failed: true })}
        />
      ) : (
        <p role="status">{current?.failed ? "Image preview unavailable." : "Loading image…"}</p>
      )}
      {current?.url && (
        <StepPreviewButton
          label="Preview image"
          resource={{
            kind: "file",
            label: image.alt || "Image output",
            entry: {
              sessionId,
              resultId: image.name,
              file: { name: image.name, path: image.name, bytes: current.bytes ?? 0 },
            },
          }}
        />
      )}
    </figure>
  );
}
