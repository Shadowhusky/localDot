import type { JsonPreview } from "@localdot/protocol";
import { type RefObject, useEffect, useRef, useState } from "react";
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

type Loaded = Extract<PreviewState, { state: "image" | "ready" }>;

// Loads a file's preview once its element is within 200 px of the viewport, and only while shown.
// Closing keeps what is shown while the file folds away; each version loads once and keeps its
// picture until the file leaves the page.
export function usePreview(
  api: ApiClient,
  target: RefObject<Element | null>,
  sessionId: string,
  name: string,
  version: number | null,
  shown: boolean,
  attempt: number,
): PreviewState {
  const key = `${sessionId}/${name}/${version ?? 0}/${attempt}`;
  const loaded = useRef(new Map<string, Loaded>());
  const [state, setState] = useState<{ key: string; state: PreviewState }>({
    key,
    state: { state: "waiting" },
  });
  useEffect(() => {
    const kept = loaded.current;
    return () => {
      for (const entry of kept.values())
        if (entry.state === "image") URL.revokeObjectURL(entry.url);
      kept.clear();
    };
  }, []);
  useEffect(() => {
    if (!shown) return;
    const known = loaded.current.get(key);
    const next = known ?? { state: "waiting" as const };
    setState((was) =>
      was.key === key && was.state.state === next.state ? was : { key, state: next },
    );
    if (known) return;
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const load = async () => {
      release = await slot(controller.signal);
      if (controller.signal.aborted) return;
      setState({ key, state: { state: "loading" } });
      const preview = await loadPreview(api, sessionId, name, version, controller.signal);
      if (controller.signal.aborted) return;
      const done: Loaded =
        preview.kind === "image"
          ? { state: "image", url: URL.createObjectURL(preview.blob), madeBy: preview.madeBy }
          : { state: "ready", preview };
      loaded.current.set(key, done);
      setState({ key, state: done });
    };
    const start = () =>
      load()
        .catch(() => {
          if (!controller.signal.aborted) setState({ key, state: { state: "error" } });
        })
        .finally(() => release?.());
    const observer =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver(
            (entries) => {
              if (!entries.some((entry) => entry.isIntersecting)) return;
              observer?.disconnect();
              void start();
            },
            { rootMargin: "200px" },
          );
    if (!observer) void start();
    else if (target.current) observer.observe(target.current);
    return () => {
      observer?.disconnect();
      controller.abort();
      release?.();
    };
  }, [api, target, sessionId, name, version, shown, key]);
  if (state.key === key) return state.state;
  return loaded.current.get(key) ?? { state: "waiting" };
}
