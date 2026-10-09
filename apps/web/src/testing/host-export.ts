import { type HostExport, ulid } from "@localdot/protocol";

// A video the host is making, as the daemon lists it.
export function hostExport(patch: Partial<HostExport> = {}): HostExport {
  const sessionId = ulid();
  return {
    id: ulid(),
    sessionId,
    screen: "desktop",
    name: "localdot-2026-10-09-1504.mp4",
    phase: "making",
    createdAt: Date.parse("2026-10-09T14:04:00Z"),
    done: 0,
    total: 0,
    elapsedMs: 0,
    leftMs: null,
    bytes: 0,
    durationS: null,
    error: null,
    request: {
      sessionId,
      fromMs: 0,
      toMs: 60_000,
      speed: 1,
      skipIdle: true,
      captions: true,
      overlays: true,
      size: { w: 1280, h: 800 },
      fps: 15,
      quality: "low",
      format: "mp4",
    },
    ...patch,
  };
}
