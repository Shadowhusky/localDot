import type { JsonPreview } from "@localdot/protocol";
import { type RefObject, useEffect, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { loadPreview } from "./api.ts";

export type PreviewState =
  | { state: "waiting" }
  | { state: "loading" }
  | { state: "image"; url: string; madeBy: "daemon" | "computer" }
  | { state: "ready"; preview: JsonPreview }
  | { state: "error" };

// At most two previews load at once, so a result with sixteen files does not start sixteen
// conversions; each also waits until its file is near the viewport.
const MAX_IN_FLIGHT = 2;
let inFlight = 0;
const queue: (() => void)[] = [];
export function slot(signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const take = () => {
      if (signal.aborted) {
        reject(signal.reason);
        queue.shift()?.();
        return;
      }
      inFlight++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        inFlight--;
        queue.shift()?.();
      });
    };
    if (inFlight < MAX_IN_FLIGHT) {
      take();
      return;
    }
    queue.push(take);
    signal.addEventListener(
      "abort",
      () => {
        const at = queue.indexOf(take);
        if (at >= 0) queue.splice(at, 1);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

// Loads a file's preview once its element is within 200 px of the viewport, and only while shown.
export function usePreview(
  api: ApiClient,
  target: RefObject<Element | null>,
  sessionId: string,
  name: string,
  version: number | null,
  shown: boolean,
  attempt: number,
): PreviewState {
  const [state, setState] = useState<PreviewState>({ state: "waiting" });
  useEffect(() => {
    void attempt;
    if (!shown) return;
    const controller = new AbortController();
    let url: string | undefined;
    let release: (() => void) | undefined;
    const load = async () => {
      release = await slot(controller.signal);
      if (controller.signal.aborted) return;
      setState({ state: "loading" });
      const loaded = await loadPreview(api, sessionId, name, version, controller.signal);
      if (controller.signal.aborted) return;
      if (loaded.kind === "image") {
        url = URL.createObjectURL(loaded.blob);
        setState({ state: "image", url, madeBy: loaded.madeBy });
      } else setState({ state: "ready", preview: loaded });
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        load()
          .catch(() => {
            if (!controller.signal.aborted) setState({ state: "error" });
          })
          .finally(() => release?.());
      },
      { rootMargin: "200px" },
    );
    if (target.current) observer.observe(target.current);
    return () => {
      observer.disconnect();
      controller.abort();
      release?.();
      if (url) URL.revokeObjectURL(url);
      setState({ state: "waiting" });
    };
  }, [api, target, sessionId, name, version, shown, attempt]);
  return state;
}
