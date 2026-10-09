import {
  EXPORT_CHUNK_BYTES,
  type ExportHostCheck,
  type ExportPageMessage,
  ExportRequest,
  RecordingInfo,
  ScreenName,
} from "@localdot/protocol";
import { emptyModel, foldEvents } from "@localdot/stage";
import { canEncodeVideo } from "mediabunny";
import { z } from "zod";
import { createApi } from "../lib/api.ts";
import { readReplayEvents } from "../replay/useReplay.ts";
import { recordingSource } from "./export-context.ts";
import type { ExportHandle, startExport } from "./exporter.ts";
import type { ExportSink } from "./sink.ts";

declare global {
  interface Window {
    __localdotExportHost?: ExportHostPage;
  }
}

// The daemon's private page, opened in its headless browser: it makes one video with the same
// exporter a viewer's page uses and hands the file to the daemon a chunk at a time.
export interface ExportHostPage {
  check(): Promise<ExportHostCheck>;
  run(spec: unknown): void;
  ack(seq: number): void;
  cancel(): void;
}

const Spec = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  screen: ScreenName,
  request: ExportRequest,
});

// The sizes asked about, largest first; the first that encodes is the largest the host makes.
const PROBE_SIZES = [
  { w: 2560, h: 1600 },
  { w: 1920, h: 1200 },
  { w: 1280, h: 800 },
  { w: 854, h: 534 },
];
const CODECS = { mp4: "avc", webm: "vp9" } as const;
const FAILED = "The video couldn't be made. Try again.";

export function base64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (native) return native.call(bytes);
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}

// Each write goes to the daemon and resolves when the daemon has it on disk.
export function bindingSink(send: (message: ExportPageMessage) => void): ExportSink & {
  ack(seq: number): void;
} {
  const waiting = new Map<number, () => void>();
  let next = 0;
  return {
    write(position, data) {
      if (data.byteLength > EXPORT_CHUNK_BYTES) return Promise.reject(new RangeError("chunk"));
      const seq = next++;
      return new Promise<void>((resolve) => {
        waiting.set(seq, resolve);
        send({ type: "chunk", seq, position, data: base64(data) });
      });
    },
    async close() {},
    async abort() {},
    ack(seq) {
      waiting.get(seq)?.();
      waiting.delete(seq);
    },
  };
}

async function largest(codec: "avc" | "vp9"): Promise<number> {
  for (const size of PROBE_SIZES)
    if (await canEncodeVideo(codec, { width: size.w, height: size.h }).catch(() => false))
      return size.w * size.h;
  return 0;
}

function graphics(): string | null {
  const canvas = new OffscreenCanvas(4, 4);
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  if (!gl) return null;
  const named = gl.getExtension("WEBGL_debug_renderer_info");
  return String(gl.getParameter(named ? named.UNMASKED_RENDERER_WEBGL : gl.RENDERER)).slice(0, 300);
}

export async function checkHost(): Promise<ExportHostCheck> {
  const decodes =
    typeof VideoDecoder !== "undefined" &&
    !!(await VideoDecoder.isConfigSupported({ codec: "avc1.42E033" }).catch(() => null))?.supported;
  return {
    maxPixels: { mp4: await largest(CODECS.mp4), webm: await largest(CODECS.webm) },
    decodes,
    graphics: graphics(),
  };
}

export function createExportHost({
  send,
  start,
  origin,
  check = checkHost,
}: {
  send(message: ExportPageMessage): void;
  start: typeof startExport;
  origin: string;
  check?: () => Promise<ExportHostCheck>;
}): ExportHostPage {
  const sink = bindingSink(send);
  let handle: ExportHandle | null = null;
  let started = false;
  const abort = new AbortController();
  const run = async (spec: z.infer<typeof Spec>) => {
    const { request, screen } = spec;
    const api = createApi(spec.token, { origin });
    const info = RecordingInfo.parse(
      await api.get(
        `/api/sessions/${request.sessionId}/recording${screen === "browser" ? "?screen=browser" : ""}`,
        { signal: abort.signal },
      ),
    );
    const model = emptyModel();
    await readReplayEvents(api, request.sessionId, model.lastSeq + 1, abort.signal, (events) => {
      foldEvents(model, events);
    });
    abort.signal.throwIfAborted();
    handle = start({
      request,
      source: recordingSource(info, {
        sessionId: request.sessionId,
        screen,
        origin,
        authorization: api.authorization(),
      }),
      model,
      activity: info.manifest.activity,
      gaps: info.manifest.gaps,
      sink,
    });
    handle.onProgress(({ done, total }) => send({ type: "progress", done, total }));
    const result = await handle.done;
    if (result.type === "done") send({ type: "done", frames: result.frames, bytes: result.bytes });
    else send({ type: "error", message: result.type === "error" ? result.message : FAILED });
  };
  return {
    check,
    run(given) {
      if (started) return;
      started = true;
      const parsed = Spec.safeParse(given);
      if (!parsed.success) {
        send({ type: "error", message: FAILED });
        return;
      }
      void run(parsed.data).catch(() => send({ type: "error", message: FAILED }));
    },
    ack: (seq) => sink.ack(seq),
    cancel() {
      abort.abort();
      handle?.cancel();
    },
  };
}
