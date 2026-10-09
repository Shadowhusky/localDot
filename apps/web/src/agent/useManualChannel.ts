import { MANUAL_STREAM_CLOSE, type ManualStreamInput } from "@localdot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { type ManualChannel, openManualChannel } from "./manual-channel.ts";

const RETRY_MS = { min: 250, max: 2000 };
// Input made while a dropped socket reopens waits for the new one, up to this many messages.
const BACKLOG = 512;

// The user's input channel, open while they hold control of a visible page. A drop reopens it, and
// input made meanwhile goes on the new socket; one whose input may have landed only in part stays
// shut, as the daemon's fence does.
export function useManualChannel(
  api: ApiClient,
  sessionId: string | null,
  requestId: string | null,
  onEnd: () => void,
) {
  const channel = useRef<ManualChannel | null>(null);
  // Set while a dropped socket waits to reopen.
  const reopening = useRef<ManualStreamInput[] | null>(null);
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
      const waiting = reopening.current ?? [];
      reopening.current = null;
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
          reopening.current = [];
          timer = setTimeout(connect, delay);
          delay = Math.min(RETRY_MS.max, delay * 2);
        },
      });
      opened = next;
      channel.current = next;
      for (const input of waiting) next.send(input);
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      reopening.current = null;
      if (channel.current === opened) channel.current = null;
      opened?.close();
    };
  }, [api, sessionId, requestId, hidden]);
  const send = useCallback((input: ManualStreamInput) => {
    if (channel.current) channel.current.send(input);
    else if (reopening.current && reopening.current.length < BACKLOG) reopening.current.push(input);
  }, []);
  const drained = useCallback(
    (timeoutMs: number) =>
      channel.current?.drained(timeoutMs) ?? Promise.resolve(!reopening.current?.length),
    [],
  );
  return { send, drained };
}
