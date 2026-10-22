import { USER_UPLOAD } from "@localdot/protocol";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { fileName } from "./attachments.ts";
import { FileTransferFailure, safeTransferName } from "./file-transfer.ts";
import { discardUpload, uploadFile } from "./resumable-upload.ts";
export interface UploadRow {
  readonly id: number;
  readonly name: string;
  // Unknown for a file a message already carried, which comes back without uploading again.
  readonly bytes?: number;
  readonly phase: "pending" | "uploading" | "placing" | "complete" | "refused" | "uncertain";
  readonly uploaded?: number;
  readonly path?: string;
  readonly explanation?: string;
  readonly preview?: string;
}
const previewOf = (file: File) =>
  file.type.startsWith("image/") &&
  file.size <= 25 * 1024 ** 2 &&
  typeof URL.createObjectURL === "function"
    ? URL.createObjectURL(file)
    : undefined;
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
    sources = useRef(new Map<number, { file: File; uploadId: string }>()),
    current = useRef(props),
    mounted = useRef(true),
    nextId = useRef(0),
    active = useRef<{ id: number; abort: AbortController } | null>(null),
    pumpRef = useRef<() => void>(() => {});
  const update = useCallback((next: UploadRow[]) => {
    const kept = new Set(next.map((row) => row.preview));
    for (const row of list.current)
      if (row.preview && !kept.has(row.preview)) URL.revokeObjectURL(row.preview);
    list.current = next;
    if (mounted.current) setRows(next);
  }, []);
  const pause = useCallback(() => {
    active.current?.abort.abort();
    active.current = null;
    update(
      list.current.map((row) =>
        ["uploading", "placing", "pending"].includes(row.phase)
          ? {
              ...row,
              phase: "uncertain",
              explanation: "Upload paused. Your progress is saved; retry to continue.",
            }
          : row,
      ),
    );
  }, [update]);
  const resume = useCallback(() => {
    update(
      list.current.map((row) =>
        row.phase === "uncertain" && sources.current.has(row.id)
          ? { ...row, phase: "pending", explanation: undefined }
          : row,
      ),
    );
    pumpRef.current();
  }, [update]);
  const { api, cellId, ready, enabled } = props;
  useLayoutEffect(() => {
    const old = current.current;
    current.current = { api, cellId, ready, enabled };
    if (old.api !== api || old.cellId !== cellId) {
      const removed = list.current.length > 0;
      pause();
      sources.current.clear();
      update([]);
      if (removed)
        setNotice("Switched computers. Files already uploaded stay on the previous computer.");
    } else if (old.ready && !ready) pause();
    else if (!old.ready && ready) resume();
    // Losing task freshness, opening settings, or sending a different message is not
    // cancellation of a user-owned file transfer.
  }, [api, cellId, ready, enabled, pause, resume, update]);
  useEffect(() => {
    mounted.current = true;
    const visible = () => {
      if (document.visibilityState === "visible") resume();
    };
    window.addEventListener("offline", pause);
    window.addEventListener("online", resume);
    window.addEventListener("pagehide", pause);
    window.addEventListener("pageshow", resume);
    document.addEventListener("visibilitychange", visible);
    return () => {
      mounted.current = false;
      active.current?.abort.abort();
      active.current = null;
      for (const row of list.current) if (row.preview) URL.revokeObjectURL(row.preview);
      sources.current.clear();
      window.removeEventListener("offline", pause);
      window.removeEventListener("online", resume);
      window.removeEventListener("pagehide", pause);
      window.removeEventListener("pageshow", resume);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [pause, resume]);
  const pump = async () => {
    const owner = current.current;
    if (active.current || !mounted.current || !owner.ready || !owner.cellId || !navigator.onLine)
      return;
    const row = list.current.find((item) => item.phase === "pending");
    const source = row && sources.current.get(row.id);
    if (!row || !source) return;
    const record = { id: row.id, abort: new AbortController() };
    active.current = record;
    const owns = () =>
      mounted.current &&
      current.current.api === owner.api &&
      current.current.cellId === owner.cellId &&
      active.current === record;
    const change = (patch: Partial<UploadRow>) => {
      if (owns())
        update(list.current.map((item) => (item.id === row.id ? { ...item, ...patch } : item)));
    };
    change({ phase: "uploading", explanation: undefined });
    try {
      const path = await uploadFile(owner.api, owner.cellId, source.file, record.abort.signal, {
        id: source.uploadId,
        progress: ({ offset, phase }) => change({ uploaded: offset, phase }),
      });
      change({ phase: "complete", path, uploaded: row.bytes });
      if (owns()) sources.current.delete(row.id);
    } catch (error) {
      const failure =
        error instanceof FileTransferFailure
          ? error
          : new FileTransferFailure(true, undefined, "Upload paused. Retry to continue.");
      change({ phase: failure.uncertain ? "uncertain" : "refused", explanation: failure.message });
    } finally {
      if (active.current === record) {
        active.current = null;
        record.abort.abort();
        void pump();
      }
    }
  };
  pumpRef.current = () => {
    void pump();
  };
  const select = (files: FileList | readonly File[]) => {
    const owner = current.current;
    if (!owner.ready || !owner.enabled || !owner.cellId || !navigator.onLine) {
      setProblem("Reconnect and check the computer before adding files.");
      return;
    }
    if (!files.length || files.length + list.current.length > USER_UPLOAD.count) {
      setProblem("Choose at most 16 attachments in this draft.");
      return;
    }
    let bytes = list.current.reduce((total, row) => total + (row.bytes ?? 0), 0);
    const chosen: File[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (
        !file ||
        !safeTransferName(file.name) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > USER_UPLOAD.bytes
      ) {
        setProblem("Choose files with safe, visible names, each at most 10 GiB.");
        return;
      }
      bytes += file.size;
      if (bytes > USER_UPLOAD.totalBytes) {
        setProblem("Attachments in one draft must total at most 20 GiB.");
        return;
      }
      chosen.push(file);
    }
    const added = chosen.map((file) => {
      const id = ++nextId.current;
      sources.current.set(id, { file, uploadId: crypto.randomUUID() });
      const preview = previewOf(file);
      return {
        id,
        name: file.name,
        bytes: file.size,
        phase: "pending" as const,
        ...(preview ? { preview } : {}),
      };
    });
    setProblem(null);
    setNotice(null);
    update([...list.current, ...added]);
    void pump();
  };
  // Files a message already carried, back in the draft: they are on the computer, so nothing
  // uploads, and removing one leaves the file where it is.
  const restore = (paths: readonly string[]) => {
    const kept = new Set(list.current.map((row) => row.path));
    const added = paths
      .filter((path) => !kept.has(path))
      .map((path) => ({
        id: ++nextId.current,
        name: fileName(path),
        phase: "complete" as const,
        path,
      }));
    setProblem(null);
    setNotice(null);
    update([...list.current, ...added]);
  };
  const remove = (id: number) => {
    if (active.current?.id === id) {
      active.current.abort.abort();
      active.current = null;
    }
    const source = sources.current.get(id),
      owner = current.current;
    if (source && owner.cellId) void discardUpload(owner.api, owner.cellId, source.uploadId);
    sources.current.delete(id);
    update(list.current.filter((item) => item.id !== id));
    void pump();
  };
  const retry = (id: number) => {
    if (!sources.current.has(id)) return;
    update(
      list.current.map((row) =>
        row.id === id && ["uncertain", "refused"].includes(row.phase)
          ? { ...row, phase: "pending", explanation: undefined }
          : row,
      ),
    );
    void pump();
  };
  return {
    rows,
    problem,
    notice,
    select,
    restore,
    remove,
    retry,
    cancel: pause,
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
