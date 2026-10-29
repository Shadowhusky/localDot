import { useCallback, useEffect, useState } from "react";
import type { BrowserStatus } from "../../../../packages/protocol/src/browser-control.ts";
import type { ApiClient } from "../lib/api.ts";
import { readBrowserStatus, restartBrowser } from "./accounts-api.ts";

// How often an open Settings reads the web browser's state.
export const BROWSER_STATUS_MS = 3000;

export interface BrowserStatusView {
  status: BrowserStatus | null;
  // A restart was asked for and the daemon has not yet confirmed it.
  requesting: boolean;
  failure: string | null;
  restart(): void;
}

export function useBrowserStatus(
  api: ApiClient,
  cellId: string | null,
  visible: boolean,
): BrowserStatusView {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    setStatus(null);
    if (!visible || !cellId) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      readBrowserStatus(api, cellId, abort.signal)
        .then(setStatus, () => {})
        .finally(() => {
          if (!abort.signal.aborted) timer = setTimeout(read, BROWSER_STATUS_MS);
        });
    };
    read();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [api, cellId, visible]);

  const restart = useCallback(() => {
    if (!cellId) return;
    setRequesting(true);
    setFailure(null);
    restartBrowser(api, cellId)
      .then(setStatus, () => setFailure("Couldn't restart the web browser. Try again."))
      .finally(() => setRequesting(false));
  }, [api, cellId]);

  return { status, requesting, failure, restart };
}
