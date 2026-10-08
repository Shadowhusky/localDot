import { vi } from "vitest";
import themeCss from "../theme.css?raw";
import tokensCss from "../ui/tokens.css?raw";
import { readTokens } from "./tokens.ts";

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
