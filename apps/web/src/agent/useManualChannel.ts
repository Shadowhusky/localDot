import { MANUAL_STREAM_CLOSE, type ManualStreamInput } from "@localdot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { type ManualChannel, openManualChannel } from "./manual-channel.ts";

const RETRY_MS = { min: 250, max: 2000 };

// The user's input channel, open while they hold control of a visible page. A drop reopens it;
// one whose input may have landed only in part stays shut, as the daemon's fence does.
export function useManualChannel(
  api: ApiClient,
  sessionId: string | null,
  requestId: string | null,
  onEnd: () => void,
) {
  const channel = useRef<ManualChannel | null>(null);
  const ended = useRef(onEnd);
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    ended.current = onEnd;
  });
  useEffect(() => {
    const changed = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  useEffect(() => {
    if (!sessionId || !requestId || hidden) return;
    let opened: ManualChannel | undefined,
      timer: ReturnType<typeof setTimeout> | undefined,
      stopped = false,
      delay = RETRY_MS.min;
    const connect = () => {
      const next = openManualChannel({
        url: api.socketUrl(`/api/agent/sessions/${sessionId}/takeover/${requestId}/stream`),
        protocols: api.socketProtocols(),
        onOpen: () => {
          delay = RETRY_MS.min;
        },
        onEnd: (code) => {
          if (channel.current === next) channel.current = null;
          ended.current();
          if (stopped || code === MANUAL_STREAM_CLOSE.uncertain) return;
          timer = setTimeout(connect, delay);
          delay = Math.min(RETRY_MS.max, delay * 2);
        },
      });
      opened = next;
      channel.current = next;
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      if (channel.current === opened) channel.current = null;
      opened?.close();
    };
  }, [api, sessionId, requestId, hidden]);
  const send = useCallback((input: ManualStreamInput) => channel.current?.send(input), []);
  const drained = useCallback(
    (timeoutMs: number) => channel.current?.drained(timeoutMs) ?? Promise.resolve(true),
    [],
  );
  return { send, drained };
}
