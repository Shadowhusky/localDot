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

export function exportSupport(): { ok: true } | { ok: false; reason: string } {
  if (typeof picker() !== "function")
    return {
      ok: false,
      reason:
        "This browser cannot save an export directly to a file. Open localDot in Chrome or Edge.",
    };
  if (typeof VideoEncoder === "undefined" || typeof OffscreenCanvas === "undefined")
    return {
      ok: false,
      reason: "This browser does not support video export. Open localDot in Chrome or Edge.",
    };
  return { ok: true };
}

export async function pickFileSink(suggestedName: string): Promise<ExportSink | null> {
  const save = picker();
  if (!save) throw new Error("Saving an export is not supported in this browser.");
  try {
    const handle = await save.call(globalThis, {
      suggestedName,
      types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }],
    });
    return fileSink(await handle.createWritable());
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null;
    throw error;
  }
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
