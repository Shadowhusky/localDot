import { describe, expect, it } from "vitest";
import { CANCELLED_NOTE } from "./job.ts";
import { exportNotice } from "./useExportToast.tsx";

describe("the island's toast for an export", () => {
  it("counts up while the video is made and offers to save it when it is ready", () => {
    expect(exportNotice({ phase: "exporting", note: null })).toEqual({
      id: "export",
      title: "Exporting…",
      live: true,
    });
    expect(exportNotice({ phase: "ready", note: null })).toEqual({
      id: "export",
      tone: "success",
      title: "Your video is ready",
      save: true,
    });
  });

  it("says why it failed, and nothing once it is saved, cancelled or still being chosen", () => {
    expect(exportNotice({ phase: "options", note: "It broke." })).toMatchObject({
      tone: "danger",
      title: "Couldn't make the video",
      description: "It broke.",
    });
    expect(exportNotice({ phase: "options", note: CANCELLED_NOTE })).toBeNull();
    expect(exportNotice({ phase: "options", note: null })).toBeNull();
    expect(exportNotice({ phase: "downloaded", note: null })).toBeNull();
    expect(exportNotice({ phase: "picking", note: null })).toBeNull();
  });
});
