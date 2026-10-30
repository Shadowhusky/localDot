import { useEffect, useState } from "react";
import type { ApiClient } from "../lib/api.ts";

interface SharedScreenProps {
  api: ApiClient;
  // The task on show, while it is live, and its newest look at the desktop.
  sessionId: string | null;
  frameId: string | null;
  // Another task is acting on the computer's screen now.
  elsewhere: boolean;
}

// While another task has the screen, the task on show is seen as it last saw the desktop: its own
// windows, with every other task's covered.
export function SharedScreen({ api, sessionId, frameId, elsewhere }: SharedScreenProps) {
  const [shown, setShown] = useState<{ key: string; url: string } | null>(null);
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
        if (!response.ok) return;
        url = URL.createObjectURL(await response.blob());
        setShown({ key, url });
      })
      .catch(() => {});
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, key, elsewhere]);
  if (!elsewhere || !shown || shown.key !== key) return null;
  return (
    <div className="shared-screen">
      <img className="shared-screen-frame" src={shown.url} alt="" />
      <p className="shared-screen-note" role="status">
        Another task is using the screen. This is where this task left it.
      </p>
    </div>
  );
}
