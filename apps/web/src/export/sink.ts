export interface ExportSink {
  write(position: number, data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

type SavePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileSystemFileHandle>;

function picker(): SavePicker | undefined {
  return (globalThis as typeof globalThis & { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
}

function fileSink(stream: FileSystemWritableFileStream): ExportSink {
  let state: "open" | "closing" | "closed" | "aborted" = "open";
  let writes = Promise.resolve();
  let closing: Promise<void> | undefined;
  let aborting: Promise<void> | undefined;
  const cancelled = () => new DOMException("Export cancelled.", "AbortError");
  return {
    write(position, data) {
      if (state !== "open") return Promise.reject(cancelled());
      if (!Number.isSafeInteger(position) || position < 0)
        return Promise.reject(new RangeError("Invalid export file position."));
      writes = writes.then(async () => {
        if (state === "aborted") throw cancelled();
        await stream.write({ type: "write", position, data: data as Uint8Array<ArrayBuffer> });
      });
      return writes;
    },
    close() {
      if (state === "aborted") return Promise.reject(cancelled());
      if (closing) return closing;
      state = "closing";
      closing = writes.then(async () => {
        if (state !== "closing") throw cancelled();
        await stream.close();
        state = "closed";
      });
      return closing;
    },
    abort() {
      if (aborting) return aborting;
      if (state === "closed") return Promise.resolve();
      state = "aborted";
      aborting = writes.catch(() => {}).then(() => stream.abort());
      return aborting;
    },
  };
}

export const NO_ENCODER = "Export needs Chrome, Edge or Safari 17 or later";
export const LONG_EXPORT = "Long exports need Chrome or Edge";
// Without a save picker the video is held in memory until it is downloaded, so it has a ceiling.
export const DOWNLOAD_LIMIT = 256 * 1024 * 1024;
const BLOCK = 4 * 1024 * 1024;

export type ExportSupport =
  | { ok: true; save: "picker" | "download" }
  | { ok: false; reason: string };

export class ExportTooLongError extends RangeError {
  override name = "ExportTooLongError";
  constructor() {
    super(LONG_EXPORT);
  }
}

export function exportSupport(): ExportSupport {
  if (typeof VideoEncoder === "undefined" || typeof OffscreenCanvas === "undefined")
    return { ok: false, reason: NO_ENCODER };
  return { ok: true, save: typeof picker() === "function" ? "picker" : "download" };
}

export async function pickFileSink(
  suggestedName: string,
): Promise<(ExportSink & { name: string }) | null> {
  const save = picker();
  if (!save) throw new Error("Saving an export is not supported in this browser.");
  try {
    const handle = await save.call(globalThis, {
      suggestedName,
      types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }],
    });
    return { ...fileSink(await handle.createWritable()), name: handle.name || suggestedName };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null;
    throw error;
  }
}

export interface MemorySink extends ExportSink {
  // The finished file, once closed. The bytes are handed to the Blob and released.
  blob(): Blob;
}

// Holds the file in fixed blocks, so a write back into its start (the MP4 header) costs no copy.
export function memorySink(limit = DOWNLOAD_LIMIT): MemorySink {
  let blocks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  let state: "open" | "closed" | "aborted" = "open";
  const cancelled = () => new DOMException("Export cancelled.", "AbortError");
  return {
    async write(position, data) {
      if (state !== "open") throw cancelled();
      if (!Number.isSafeInteger(position) || position < 0)
        throw new RangeError("Invalid export file position.");
      const end = position + data.byteLength;
      if (end > limit) throw new ExportTooLongError();
      for (let offset = 0; offset < data.byteLength; ) {
        const at = position + offset;
        const index = Math.floor(at / BLOCK);
        const start = at - index * BLOCK;
        const count = Math.min(BLOCK - start, data.byteLength - offset);
        const block = blocks[index] ?? new Uint8Array(BLOCK);
        blocks[index] = block;
        block.set(data.subarray(offset, offset + count), start);
        offset += count;
      }
      size = Math.max(size, end);
    },
    async close() {
      if (state === "aborted") throw cancelled();
      state = "closed";
    },
    async abort() {
      state = "aborted";
      blocks = [];
    },
    blob() {
      if (state !== "closed") throw new Error("The export has not finished.");
      const parts: Uint8Array<ArrayBuffer>[] = [];
      for (let index = 0; index * BLOCK < size; index++)
        parts.push(
          (blocks[index] ?? new Uint8Array(BLOCK)).subarray(
            0,
            Math.min(BLOCK, size - index * BLOCK),
          ),
        );
      blocks = [];
      return new Blob(parts, { type: "video/mp4" });
    },
  };
}

// The caller keeps `url` until the person is done with the file: a browser that asks first (Safari
// on a phone) reads it only after the answer, and the answer may be no.
export function downloadFile(url: string, name: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

export async function opfsSink(name: string): Promise<ExportSink> {
  if (new URLSearchParams(location.search).get("exportProbe") !== "1")
    throw new Error("The export probe is disabled.");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(name))
    throw new RangeError("Invalid export probe filename.");
  const directory = await navigator.storage.getDirectory();
  const handle = await directory.getFileHandle(name, { create: true });
  return fileSink(await handle.createWritable());
}
