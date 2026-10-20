import { act, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { readSource } from "./read-source.ts";
import { readTokens } from "./tokens.ts";

// Under jsdom a literal new URL(…, import.meta.url) becomes a served asset's address.
const here = import.meta.url;
const [tokensCss, themeCss] = await Promise.all([
  readSource(new URL("../ui/tokens.css", here)),
  readSource(new URL("../theme.css", here)),
]);

// Keeps every worker the stage starts and what it is sent, so a test can read the protocol.
export class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly sent: { message: { type: string; [key: string]: unknown }; transfer: unknown[] }[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  terminated = false;
  constructor(
    readonly url: URL | string,
    readonly options?: unknown,
  ) {
    FakeWorker.instances.push(this);
  }
  postMessage(message: { type: string }, transfer: unknown[] = []) {
    this.sent.push({ message, transfer });
  }
  terminate() {
    this.terminated = true;
  }
}

// jsdom has none of the APIs the stage taps frames with, like Safari and Firefox. These stand-ins
// let it run as in Chromium; the returned function puts jsdom back.
export function fakeChromium(): () => void {
  // Apply the real tokens inline: jsdom does not reliably compute stylesheet variables.
  const root = document.documentElement;
  const previousStyle = root.style.cssText;
  for (const [name, value] of readTokens([tokensCss, themeCss]))
    root.style.setProperty(name, value);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  FakeWorker.instances = [];
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal(
    "MediaStreamTrackProcessor",
    class {
      readonly readable = new ReadableStream();
    },
  );
  vi.stubGlobal(
    "VideoFrame",
    class {
      readonly close = vi.fn();
      constructor(readonly source: unknown) {}
    },
  );
  vi.stubGlobal("OffscreenCanvas", class {});
  Object.defineProperty(HTMLCanvasElement.prototype, "transferControlToOffscreen", {
    configurable: true,
    value: () => ({ offscreen: true }),
  });
  return () => {
    root.style.cssText = previousStyle;
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLCanvasElement.prototype, "transferControlToOffscreen");
  };
}

// Puts a stand-in for Selkies' <video id="videoStream"> into the client iframe's document, playing
// a track with the given id.
export function playInClient(iframe: HTMLIFrameElement, trackId: string): void {
  const doc = iframe.contentDocument;
  if (!doc) throw new Error("the client iframe has no document");
  doc.getElementById("videoStream")?.remove();
  const video = doc.createElement("video");
  video.id = "videoStream";
  const track = { id: trackId, clone: () => ({ id: `${trackId}-clone`, stop: () => {} }) };
  Object.defineProperty(video, "srcObject", { value: { getVideoTracks: () => [track] } });
  Object.defineProperty(video, "readyState", { value: 4 });
  doc.appendChild(video);
}

// A connected relay alone is not a rendered frame. Integration fixtures that need a ready
// screen complete the same track-transfer and presentation acknowledgement as the real worker.
export async function presentFrame(selector = "iframe.desktop-frame") {
  await waitFor(() => {
    if (!document.querySelector(selector)) throw new Error("waiting for stream client");
  });
  const frame = [...document.querySelectorAll<HTMLIFrameElement>(selector)].at(-1);
  if (!frame) throw new Error("stream client disappeared");
  const previous = new Set(FakeWorker.instances.flatMap((w) => w.sent));
  playInClient(frame, "fixture-presented-track");
  const worker = () =>
    FakeWorker.instances.findLast(
      (w) =>
        !w.terminated && w.sent.some((row) => row.message.type === "frames" && !previous.has(row)),
    );
  await waitFor(() => {
    if (!worker()) throw new Error("waiting for transferred frames");
  });
  act(() =>
    worker()?.onmessage?.({
      data: {
        type: "stats",
        sourceId: worker()?.sent.findLast((row) => row.message.type === "frames")?.message.sourceId,
        stats: { presented: 1, fps: 30, lastFrameAt: 1, width: 1280, height: 720 },
      },
    }),
  );
}
