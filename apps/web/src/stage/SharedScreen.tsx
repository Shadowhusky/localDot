import { useEffect, useState } from "react";
import type { ApiClient } from "../lib/api.ts";

export interface SharedLook {
  // The task's last look at the desktop, once read.
  url: string | null;
  // It is still on the way: a conversation just taken up waits for it.
  waiting: boolean;
}

// While another task (`elsewhere`) acts on the computer's screen, the live task on show is seen as
// it last saw the desktop, in its newest look (`frameId`).
export function useSharedLook(
  api: ApiClient,
  sessionId: string | null,
  frameId: string | null,
  elsewhere: boolean,
): SharedLook {
  const [read, setRead] = useState<{ key: string; url: string | null } | null>(null);
  const key = sessionId && frameId ? `/api/sessions/${sessionId}/frames/${frameId}` : null;
  useEffect(() => {
    if (!elsewhere || !key) return;
    const controller = new AbortController();
    let url: string | undefined;
    void api
      .fetch(`${api.socketUrl("").replace(/^ws/, "http")}${key}`, {
        headers: { authorization: api.authorization() },
        signal: controller.signal,
      })
      .then(async (response) => {
        if (!response.ok) {
          setRead({ key, url: null });
          return;
        }
        url = URL.createObjectURL(await response.blob());
        setRead({ key, url });
      })
      .catch(() => {
        // A look that can't be read leaves the live picture on show, rather than a wait.
        if (!controller.signal.aborted) setRead({ key, url: null });
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, key, elsewhere]);
  if (!elsewhere || !key) return { url: null, waiting: false };
  return read?.key === key ? { url: read.url, waiting: false } : { url: null, waiting: true };
}

// The task's own windows, with every other task's covered.
export function SharedScreen({ look }: { look: SharedLook }) {
  if (!look.url) return null;
  return (
    <div className="shared-screen">
      <img className="shared-screen-frame" src={look.url} alt="" />
      <p className="shared-screen-note" role="status">
        Another task is using the screen. This is where this task left it.
      </p>
    </div>
  );
}
