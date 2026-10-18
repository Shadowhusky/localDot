// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { openCapture } from "./capture.ts";

afterEach(() => vi.unstubAllGlobals());

it("does not open a microphone for an already cancelled turn", async () => {
  const media = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: media } });
  await expect(openCapture(true, AbortSignal.abort())).rejects.toMatchObject({ failure: "failed" });
  expect(media).not.toHaveBeenCalled();
});

it("releases a microphone granted after its turn was cancelled", async () => {
  const pending = Promise.withResolvers<MediaStream>();
  const stop = vi.fn();
  const audio = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => pending.promise } });
  vi.stubGlobal("AudioContext", audio);
  const controller = new AbortController();
  const opening = openCapture(true, controller.signal);
  controller.abort();
  pending.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream);
  await expect(opening).rejects.toMatchObject({ failure: "failed" });
  expect(stop).toHaveBeenCalledOnce();
  expect(audio).not.toHaveBeenCalled();
});

it("releases the microphone when audio initialization fails", async () => {
  const stop = vi.fn();
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) },
  });
  vi.stubGlobal(
    "AudioContext",
    class {
      constructor() {
        throw new Error("audio unavailable");
      }
    },
  );
  await expect(openCapture(true)).rejects.toMatchObject({ failure: "failed" });
  expect(stop).toHaveBeenCalledOnce();
});

it("closes the audio graph too when the recorder cannot be created", async () => {
  const stop = vi.fn();
  const close = vi.fn(async () => {});
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) },
  });
  vi.stubGlobal(
    "AudioContext",
    class {
      resume = async () => {};
      close = close;
      createAnalyser = () => ({ fftSize: 1024 });
      createMediaStreamSource = () => ({ connect: () => {} });
    },
  );
  vi.stubGlobal(
    "MediaRecorder",
    class {
      constructor() {
        throw new Error("recorder unavailable");
      }
    },
  );
  await expect(openCapture(true)).rejects.toMatchObject({ failure: "failed" });
  expect(stop).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
