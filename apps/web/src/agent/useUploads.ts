import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { FILE_LIMITS, FileTransferFailure, safeTransferName, uploadFile } from "./file-transfer.ts";
export interface UploadRow {
  readonly id: number;
  readonly name: string;
  readonly bytes: number;
  readonly phase: "pending" | "uploading" | "complete" | "refused" | "uncertain";
  readonly path?: string;
  readonly explanation?: string;
}
interface Owner {
  api: ApiClient;
  cellId: string | null;
  ready: boolean;
  enabled: boolean;
}
export function useUploads(props: Owner) {
  const [rows, setRows] = useState<readonly UploadRow[]>([]),
    [problem, setProblem] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const list = useRef<UploadRow[]>([]),
    sources = useRef(new Map<number, File>()),
    current = useRef(props),
    mounted = useRef(true),
    epoch = useRef(0),
    nextId = useRef(0),
    active = useRef<{ id: number; abort: AbortController } | null>(null);
  const update = useCallback((next: UploadRow[]) => {
    list.current = next;
    if (mounted.current) setRows(next);
  }, []);
  const interrupted = useCallback(() => {
    epoch.current++;
    active.current?.abort.abort();
    active.current = null;
    sources.current.clear();
    update(
      list.current.map((row) =>
        row.phase === "uploading"
          ? {
              ...row,
              phase: "uncertain",
              explanation:
                "The upload may have finished. Check Downloads before selecting it again.",
            }
          : row.phase === "pending"
            ? { ...row, phase: "refused", explanation: "Upload cancelled before it started." }
            : row,
      ),
    );
  }, [update]);
  const { api, cellId, ready, enabled } = props;
  useLayoutEffect(() => {
    const old = current.current;
    current.current = { api, cellId, ready, enabled };
    if (old.api !== api || old.cellId !== cellId || (old.ready && !ready)) {
      const removed = list.current.length > 0;
      interrupted();
      update([]);
      if (removed)
        setNotice(
          "Your computer was interrupted, so the files you added were removed. Add them again.",
        );
    } else if (old.enabled && !enabled) interrupted();
  }, [api, cellId, ready, enabled, interrupted, update]);
  useEffect(() => {
    mounted.current = true;
    const retire = () => interrupted();
    const hidden = () => {
      if (document.visibilityState === "hidden") retire();
    };
    window.addEventListener("pagehide", retire);
    window.addEventListener("offline", retire);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      mounted.current = false;
      epoch.current++;
      active.current?.abort.abort();
      active.current = null;
      sources.current.clear();
      window.removeEventListener("pagehide", retire);
      window.removeEventListener("offline", retire);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [interrupted]);
  const pump = async () => {
    if (active.current) return;
    const owner = current.current,
      version = epoch.current;
    if (!mounted.current || !owner.ready || !owner.enabled || !owner.cellId || !navigator.onLine)
      return;
    const row = list.current.find((item) => item.phase === "pending");
    if (!row) return;
    const file = sources.current.get(row.id);
    if (!file) return;
    const abort = new AbortController(),
      record = { id: row.id, abort };
    active.current = record;
    update(
      list.current.map((item) => (item.id === row.id ? { ...item, phase: "uploading" } : item)),
    );
    const owns = () =>
      mounted.current &&
      epoch.current === version &&
      current.current.api === owner.api &&
      current.current.cellId === owner.cellId &&
      current.current.ready &&
      current.current.enabled &&
      active.current === record;
    try {
      const path = await uploadFile(owner.api, owner.cellId, file, abort.signal);
      if (owns())
        update(
          list.current.map((item) =>
            item.id === row.id ? { ...item, phase: "complete", path } : item,
          ),
        );
    } catch (error) {
      const failure = error instanceof FileTransferFailure ? error : new FileTransferFailure(true);
      if (owns())
        update(
          list.current.map((item) =>
            item.id === row.id
              ? {
                  ...item,
                  phase: failure.uncertain ? "uncertain" : "refused",
                  explanation: failure.message,
                }
              : item,
          ),
        );
    } finally {
      sources.current.delete(row.id);
      if (active.current === record) {
        active.current = null;
        abort.abort();
        if (mounted.current && epoch.current === version) void pump();
      }
    }
  };
  const select = (files: FileList | readonly File[]) => {
    const owner = current.current;
    if (
      !owner.ready ||
      !owner.enabled ||
      !owner.cellId ||
      !navigator.onLine ||
      document.visibilityState === "hidden"
    ) {
      setProblem("Reconnect and check the computer before adding files.");
      return;
    }
    if (!files.length || files.length + list.current.length > FILE_LIMITS.count) {
      setProblem("Choose at most 16 attachments in this draft.");
      return;
    }
    let bytes = list.current.reduce((total, row) => total + row.bytes, 0);
    const chosen: File[] = [];
    const names = new Set(list.current.map((row) => row.name));
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (
        !file ||
        !safeTransferName(file.name) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > FILE_LIMITS.bytes ||
        names.has(file.name)
      ) {
        setProblem(
          "Choose files with distinct visible names, each at most 100 MiB. Hidden, unsafe or key-shaped names are refused.",
        );
        return;
      }
      bytes += file.size;
      if (bytes > FILE_LIMITS.bytes) {
        setProblem("Attachments in one draft must total at most 100 MiB.");
        return;
      }
      names.add(file.name);
      chosen.push(file);
    }
    const added = chosen.map((file) => {
      const id = ++nextId.current;
      sources.current.set(id, file);
      return { id, name: file.name, bytes: file.size, phase: "pending" as const };
    });
    setProblem(null);
    setNotice(null);
    update([...list.current, ...added]);
    void pump();
  };
  const remove = (id: number) => {
    if (active.current?.id === id) interrupted();
    const row = list.current.find((item) => item.id === id);
    if (row?.phase === "uncertain" || row?.phase === "uploading")
      setProblem(
        "The removed upload may remain in Downloads. Check it before selecting the same file again.",
      );
    sources.current.delete(id);
    update(list.current.filter((item) => item.id !== id));
    void pump();
  };
  return {
    rows,
    problem,
    notice,
    select,
    remove,
    cancel: interrupted,
    forMessage: () => {
      if (!list.current.length) return [];
      if (
        list.current.some((row) => row.phase !== "complete" || !row.path) ||
        !current.current.ready
      )
        return null;
      return list.current.map((row) => ({ id: row.id, path: row.path as string }));
    },
    acknowledge: (ids: readonly number[]) =>
      update(list.current.filter((row) => !ids.includes(row.id))),
    blocked: rows.some((row) => row.phase !== "complete" || !row.path),
  };
}
