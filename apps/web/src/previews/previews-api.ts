import {
  PreviewOpened,
  PreviewRefusal,
  type PreviewRequest,
  PreviewsStatus,
} from "@localdot/protocol";
import { type ApiClient, ApiError } from "../lib/api.ts";

const previewsPath = (sessionId: string) =>
  `/api/sessions/${encodeURIComponent(sessionId)}/previews`;

export async function readPreviews(
  api: ApiClient,
  sessionId: string,
  signal?: AbortSignal,
): Promise<PreviewsStatus> {
  return PreviewsStatus.parse(await api.get<unknown>(previewsPath(sessionId), { signal }));
}

export async function requestPreview(
  api: ApiClient,
  sessionId: string,
  request: PreviewRequest,
): Promise<PreviewOpened> {
  return PreviewOpened.parse(await api.post<unknown>(previewsPath(sessionId), request));
}

export function stopPreview(api: ApiClient, sessionId: string, id: string): Promise<void> {
  return api.del(`${previewsPath(sessionId)}/${encodeURIComponent(id)}`);
}

const COULD_NOT_OPEN = "localDot couldn't open the preview. Try again in a moment.";

// The daemon refuses in its own plain words; anything else stays out of sight.
export function refusalOf(error: unknown): PreviewRefusal {
  if (error instanceof ApiError) {
    try {
      const refusal = PreviewRefusal.safeParse(JSON.parse(error.message));
      if (refusal.success) return refusal.data;
    } catch {}
  }
  return { message: COULD_NOT_OPEN };
}
