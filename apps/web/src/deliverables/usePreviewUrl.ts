import { useEffect, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { type FileRef, keptPreviewBase, previewBase, previewUrl } from "./api.ts";

// A kept link shows the file at once; the daemon's answer replaces it if the daemon has restarted.
export function usePreviewUrl(
  api: ApiClient,
  file: FileRef,
  wanted: boolean,
  attempt = 0,
): string | null | "failed" {
  const [url, setUrl] = useState<{ key: string; url: string | "failed" } | null>(null);
  const key = JSON.stringify(file);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key names the file; attempt asks again.
  useEffect(() => {
    if (!wanted) return;
    const controller = new AbortController();
    const show = (next: string) =>
      setUrl((was) => (was?.key === key && was.url === next ? was : { key, url: next }));
    const kept = keptPreviewBase(api, file.sessionId);
    if (kept) show(previewUrl(api, kept, file));
    previewBase(api, file.sessionId, controller.signal).then(
      (base) => !controller.signal.aborted && show(previewUrl(api, base, file)),
      () => !controller.signal.aborted && !kept && show("failed"),
    );
    return () => controller.abort();
  }, [api, key, wanted, attempt]);
  return url?.key === key ? url.url : null;
}
