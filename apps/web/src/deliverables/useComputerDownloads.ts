import { computerFileName } from "@localdot/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileState } from "../agent/ResultFiles.tsx";
import type { ApiClient } from "../lib/api.ts";
import { downloadComputerFile } from "./api.ts";
import { anyEntryKey, type ComputerEntry, type ViewerDownloads } from "./viewer/scope.tsx";

// How long a finished download shows its check.
const DONE_MS = 1500;

// One download at a time of files on dot's computer, fetched only on the user's press by the path the
// task listed, and handed to the browser as an inert attachment.
export function useComputerDownloads(api: ApiClient | null): ViewerDownloads<ComputerEntry> {
  const [states, setStates] = useState<ReadonlyMap<string, FileState>>(new Map());
  const active = useRef<AbortController | null>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const mark = useCallback((key: string, state: FileState | null) => {
    setStates((old) => {
      const next = new Map(old);
      if (state) next.set(key, state);
      else next.delete(key);
      return next;
    });
  }, []);
  useEffect(() => {
    const pending = timers.current;
    return () => {
      active.current?.abort();
      for (const timer of pending) clearTimeout(timer);
    };
  }, []);
  const later = useCallback((work: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      work();
    }, ms);
    timers.current.add(timer);
  }, []);
  const request = useCallback(
    async (entry: ComputerEntry) => {
      if (!api || active.current) return;
      const key = anyEntryKey(entry);
      const name = computerFileName(entry.path);
      const abort = new AbortController();
      active.current = abort;
      mark(key, "busy");
      try {
        const blob = await downloadComputerFile(
          api,
          { sessionId: entry.sessionId, name, path: entry.path },
          abort.signal,
        );
        if (abort.signal.aborted) return;
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = name;
        anchor.hidden = true;
        anchor.rel = "noopener noreferrer";
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        later(() => URL.revokeObjectURL(url), 1000);
        mark(key, "done");
        later(() => mark(key, null), DONE_MS);
      } catch {
        if (!abort.signal.aborted) mark(key, "failed");
      } finally {
        if (active.current === abort) active.current = null;
      }
    },
    [api, mark, later],
  );
  return useMemo(() => {
    const busy = [...states.values()].includes("busy");
    return {
      state: (entry) => states.get(anyEntryKey(entry)),
      blocked: (entry) =>
        busy && states.get(anyEntryKey(entry)) !== "busy"
          ? "Another download is still running."
          : undefined,
      request: (entry) => void request(entry),
    };
  }, [states, request]);
}
