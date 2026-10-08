// @vitest-environment jsdom
import { emptyModel } from "@localdot/stage";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../lib/api.ts";
import { ExportPopover } from "./ExportPopover.tsx";
import type { ExportContext } from "./export-context.ts";
import type { ExportJob, ExportJobState } from "./job.ts";
import { LONG_EXPORT } from "./sink.ts";

const encodable = vi.hoisted(() => ({ widths: new Set([1280, 1920]) }));
vi.mock("mediabunny", () => ({
  canEncodeVideo: async (_codec: string, size: { width: number }) =>
    encodable.widths.has(size.width),
}));

const sessionId = "01K00000000000000000000000";
const IDLE: ExportJobState = {
  phase: "options",
  done: 0,
  total: 0,
  startedAt: null,
  file: null,
  note: null,
  context: null,
};

function context(patch: Partial<ExportContext> = {}, endMs = 60_000): ExportContext {
  const model = emptyModel();
  model.startT = 0;
  model.ended = { t: endMs, reason: "done" };
  return {
    sessionId,
    model,
    activity: [{ from: 0, to: 60_000_000 }],
    gaps: [],
    source: { sessionId, origin: "http://localhost", authorization: "", video: null, gaps: [] },
    whole: { fromMs: 0, toMs: endMs },
    chapter: { fromMs: 15_000, toMs: 17_500 },
    selection: null,
    atMs: 16_000,
    ...patch,
  };
}

function fakeJob(state: Partial<ExportJobState> = {}) {
  const snapshot = { ...IDLE, ...state };
  return {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    start: vi.fn(async () => {}),
    cancel: vi.fn(),
    save: vi.fn(),
    dismiss: vi.fn(),
    reset: vi.fn(),
    dispose: vi.fn(),
  } satisfies ExportJob;
}

function Harness({
  job,
  exportContext,
  onClose = () => {},
}: {
  job: ExportJob;
  exportContext: ExportContext;
  onClose?: () => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchor} type="button">
        Export MP4
      </button>
      <ExportPopover
        api={{} as ApiClient}
        job={job}
        context={exportContext}
        open
        onClose={onClose}
        anchor={anchor}
      />
    </>
  );
}

async function show(job: ExportJob, exportContext = context(), onClose?: () => void) {
  render(<Harness job={job} exportContext={exportContext} onClose={onClose} />);
  await act(async () => {});
  return screen.getByRole("dialog", { name: "Export MP4" });
}

const description = (element: Element) =>
  (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent)
    .join(" ");

beforeEach(() => {
  vi.stubGlobal("VideoEncoder", class {});
  vi.stubGlobal("OffscreenCanvas", class {});
  vi.stubGlobal("showSaveFilePicker", vi.fn());
  encodable.widths = new Set([1280, 1920]);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Export MP4", () => {
  it("is made of the kit's controls, with no native select, radio or file input", async () => {
    const panel = await show(fakeJob());
    expect(
      panel.querySelector("select, input[type=radio], input[type=file], progress, meter"),
    ).toBe(null);
    for (const name of ["Range", "Speed", "Size"])
      expect(screen.getByRole("radiogroup", { name })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Skip idle" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Captions" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Whole" }).getAttribute("aria-checked")).toBe("true");
    expect(panel.textContent).toContain("0:00 – 1:00");
    expect(panel.textContent).toContain("1:00 video · up to");
  });

  it("offers Selection once I and O have marked one, and says how until then", async () => {
    await show(fakeJob());
    const off = screen.getByRole("radio", { name: "Selection" });
    expect(off.getAttribute("aria-disabled")).toBe("true");
    expect(description(off)).toContain("Press I and O on the timeline to mark a stretch");
    cleanup();
    const panel = await show(fakeJob(), context({ selection: { fromMs: 5_000, toMs: 35_000 } }));
    const on = screen.getByRole("radio", { name: "Selection" });
    expect(on.getAttribute("aria-checked")).toBe("true");
    expect(panel.textContent).toContain("0:05 – 0:35");
    fireEvent.click(screen.getByRole("radio", { name: "This step" }));
    expect(panel.textContent).toContain("0:15 – 0:17");
  });

  it("starts the export with what was chosen", async () => {
    const job = fakeJob();
    await show(job);
    fireEvent.click(screen.getByRole("radio", { name: "4×" }));
    fireEvent.click(screen.getByRole("switch", { name: "Captions" }));
    fireEvent.click(screen.getByRole("button", { name: "Save…" }));
    expect(job.start).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId }),
      expect.objectContaining({
        fromMs: 0,
        toMs: 60_000,
        speed: 4,
        captions: false,
        skipIdle: true,
      }),
      15,
    );
  });

  it("says when this browser cannot make a size, and keeps Save off for it", async () => {
    encodable.widths = new Set([1280]);
    const exportContext = context();
    exportContext.source.geometry = { w: 2560, h: 1600, scale: 2 };
    await show(fakeJob(), exportContext);
    const large = screen.getByRole("radio", { name: "1080p" });
    expect(large.getAttribute("aria-disabled")).toBe("true");
    expect(description(large)).toContain("This browser can't make 1080p video");
    const save = screen.getByRole("button", { name: "Save…" });
    expect(save.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "720p" }));
    expect(save.getAttribute("aria-disabled")).toBeNull();
  });

  it("keeps a long export off the download path and says which browsers can save it", async () => {
    vi.stubGlobal("showSaveFilePicker", undefined);
    const job = fakeJob();
    const panel = await show(job, context({}, 2 * 60 * 60_000));
    fireEvent.click(screen.getByRole("switch", { name: "Skip idle" }));
    const save = screen.getByRole("button", { name: "Save" });
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(description(save)).toContain(LONG_EXPORT);
    expect(panel.textContent).toContain(LONG_EXPORT);
    fireEvent.click(save);
    expect(job.start).not.toHaveBeenCalled();
  });

  it("shows progress as a share and the time left, and Keep working puts it away", async () => {
    const onClose = vi.fn();
    const job = fakeJob({
      phase: "exporting",
      done: 420,
      total: 1000,
      startedAt: performance.now() - 4200,
    });
    const panel = await show(job, context(), onClose);
    const bar = screen.getByRole("progressbar", { name: "Export progress" });
    expect(bar.getAttribute("aria-valuetext")).toBe("42%");
    expect(panel.textContent).toMatch(/42% · about 0:0[56] left/);
    expect(screen.getByRole("button", { name: "Details" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep working" }));
    expect(onClose).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(job.cancel).toHaveBeenCalledOnce();
  });

  it("keeps its size from the first choice to the saved file", async () => {
    const panel = await show(fakeJob({ phase: "exporting", total: 10 }));
    const views = panel.querySelector(".export-views");
    expect(views?.children).toHaveLength(2);
    expect(panel.querySelector(".export-options")?.hasAttribute("inert")).toBe(true);
    expect(panel.querySelector(".export-options [role=radiogroup]")).not.toBeNull();
  });

  it("names the saved file with its size and length", async () => {
    const job = fakeJob({
      phase: "saved",
      file: { name: "localdot-2026-10-08-0901.mp4", bytes: 3.25 * 1024 * 1024, durationS: 34 },
    });
    const panel = await show(job);
    expect(screen.getByRole("status").textContent).toContain("Video saved");
    expect(panel.textContent).toContain("localdot-2026-10-08-0901.mp4");
    expect(panel.textContent).toContain("3.3 MB · 0:34");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(job.reset).toHaveBeenCalledOnce();
  });

  it("saves a finished download only when asked", async () => {
    vi.stubGlobal("showSaveFilePicker", undefined);
    const job = fakeJob({
      phase: "ready",
      file: { name: "localdot-2026-10-08-0901.mp4", bytes: 2048, durationS: 0.6 },
    });
    const panel = await show(job);
    expect(panel.textContent).toContain("Your video is ready");
    expect(panel.textContent).toContain("2 KB · 0:01");
    fireEvent.click(screen.getByRole("button", { name: "Save video" }));
    expect(job.save).toHaveBeenCalledOnce();
  });

  it("offers a downloaded video again, since the browser's prompt may have been cancelled", async () => {
    vi.stubGlobal("showSaveFilePicker", undefined);
    const job = fakeJob({
      phase: "downloaded",
      file: { name: "localdot-2026-10-08-0901.mp4", bytes: 2048, durationS: 0.6 },
    });
    await show(job);
    expect(screen.getByRole("status").textContent).toContain("Downloaded");
    expect(screen.getByRole("status").textContent).not.toContain("saved");
    fireEvent.click(screen.getByRole("button", { name: "Save again" }));
    expect(job.save).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(job.reset).toHaveBeenCalledOnce();
  });
});
