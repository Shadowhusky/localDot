// @vitest-environment jsdom
import { emptyModel } from "@localdot/stage";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../lib/api.ts";
import { ExportSheet } from "./ExportSheet.tsx";
import type { ExportContext } from "./export-context.ts";
import type { HostExports, HostExportsView } from "./host-exports.ts";
import type { ExportJob, ExportJobState } from "./job.ts";
import { LONG_EXPORT } from "./sink.ts";

const encodable = vi.hoisted(() => ({ widths: new Set([768, 1280, 1920]), vp9: true }));
vi.mock("mediabunny", () => ({
  canEncodeVideo: async (codec: string, size: { width: number }) =>
    (codec !== "vp9" || encodable.vp9) && encodable.widths.has(size.width),
}));
const rate = vi.hoisted(() => ({ fps: 60 as number | null }));
vi.mock("./source-rate.ts", () => ({ probeFrameRate: async () => rate.fps }));

const sessionId = "01K00000000000000000000000";
const IDLE: ExportJobState = {
  phase: "options",
  done: 0,
  total: 0,
  startedAt: null,
  file: null,
  note: null,
  context: null,
  where: null,
  waiting: false,
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

// A host that never answered: this page makes the video, as before.
const PAGE: HostExportsView = { host: null, exports: [] };

function fakeHost(view: HostExportsView = PAGE): HostExports {
  return {
    view: () => view,
    subscribe: () => () => {},
    refresh: vi.fn(),
    start: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn(),
    remove: vi.fn(),
    link: vi.fn(),
    dispose: vi.fn(),
  };
}

function Harness({
  job,
  exportContext,
  host = fakeHost(),
  onClose = () => {},
}: {
  job: ExportJob;
  exportContext: ExportContext;
  host?: HostExports;
  onClose?: () => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchor} type="button">
        Export video
      </button>
      <ExportSheet
        api={{} as ApiClient}
        job={job}
        host={host}
        context={exportContext}
        open
        onClose={onClose}
        anchor={anchor}
      />
    </>
  );
}

async function show(
  job: ExportJob,
  exportContext = context(),
  onClose?: () => void,
  host?: HostExports,
) {
  render(<Harness job={job} exportContext={exportContext} onClose={onClose} host={host} />);
  await act(async () => {});
  return screen.getByRole("dialog", { name: "Export video" });
}

const description = (element: Element) =>
  (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent)
    .join(" ");

let recordings = 0;
// A recording of the computer's whole 2560 × 1600 screen, with video. Each is a new recording: the
// sheet reads a recording's frame rate once.
function screenContext(patch: Partial<ExportContext> = {}): ExportContext {
  const base = context(patch);
  base.source = {
    ...base.source,
    video: { upto: null },
    geometry: { w: 2560, h: 1600, scale: 1 },
    sessionId: `${sessionId.slice(0, -2)}${String(++recordings).padStart(2, "0")}`,
  };
  base.sessionId = base.source.sessionId;
  return base;
}

const preset = (name: string) =>
  within(screen.getByRole("radiogroup", { name: "Preset" })).getByRole("radio", { name });
const speed = (name: string) =>
  within(screen.getByRole("radiogroup", { name: "Speed" })).getByRole("radio", { name });

const more = () => fireEvent.click(screen.getByRole("button", { name: /More options/ }));

const started = (job: ReturnType<typeof fakeJob>) => job.start.mock.calls[0] as unknown[];

beforeEach(() => {
  vi.stubGlobal("VideoEncoder", class {});
  vi.stubGlobal("OffscreenCanvas", class {});
  vi.stubGlobal("showSaveFilePicker", vi.fn());
  encodable.widths = new Set([768, 1280, 1920]);
  encodable.vp9 = true;
  rate.fps = 60;
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Export video", () => {
  it("leads with the presets, each with its size and wait, from the kit's controls", async () => {
    const panel = await show(fakeJob());
    expect(panel.querySelector("select, input[type=file], progress, meter")).toBe(null);
    const presets = screen.getByRole("radiogroup", { name: "Preset" });
    expect(panel.querySelector("[role=radiogroup]")).toBe(presets);
    expect(preset("Quality")).toHaveProperty("checked", true);
    expect(presets.textContent).toContain("1920 × 1200 · 60 fps · sharpest");
    expect(presets.textContent).toContain("1280 × 800 · 15 fps · smallest");
    const custom = preset("Custom");
    expect(custom.getAttribute("aria-disabled")).toBe("true");
    expect(description(custom)).toContain("Set under More options");
    // Every row keeps a slot for its estimate, so nothing moves as they are worked out.
    expect(presets.querySelectorAll(".export-estimate")).toHaveLength(3);
    expect(presets.querySelectorAll(".export-estimate[data-hidden]")).toHaveLength(1);
    for (const name of ["Range", "Speed"])
      expect(screen.getByRole("radiogroup", { name })).toBeTruthy();
    expect(panel.textContent).toContain("0:00 – 1:00");
    expect(panel.textContent).toMatch(/1:00 video · about [\d.]+ MB · ready in /);
  });

  it("makes Quality at the computer's own size, and says when the browser can't", async () => {
    await show(fakeJob(), screenContext());
    expect(screen.getByRole("radiogroup", { name: "Preset" }).textContent).toContain(
      "1920 × 1200 · 60 fps",
    );
    more();
    expect(screen.getByRole("radio", { name: "Original" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(description(screen.getByRole("radio", { name: "Original" }))).toContain(
      "This browser can't make Original video",
    );
    cleanup();
    encodable.widths.add(2560);
    await show(fakeJob(), screenContext());
    expect(screen.getByRole("radiogroup", { name: "Preset" }).textContent).toContain(
      "2560 × 1600 · 60 fps · sharpest",
    );
  });

  it("offers no more frames a second than the recording has", async () => {
    rate.fps = 30;
    await show(fakeJob(), screenContext());
    expect(screen.getByRole("radiogroup", { name: "Preset" }).textContent).toContain("30 fps");
    more();
    for (const fps of ["50", "60"]) {
      const option = screen.getByRole("radio", { name: fps });
      expect(option.getAttribute("aria-disabled")).toBe("true");
      expect(description(option)).toContain("The recording has no more than 30 fps at this speed");
    }
    fireEvent.click(speed("2×"));
    expect(screen.getByRole("radio", { name: "60" }).getAttribute("aria-disabled")).toBeNull();
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

  it("starts the export with the preset and speed chosen", async () => {
    const job = fakeJob();
    await show(job);
    fireEvent.click(preset("Fast"));
    fireEvent.click(speed("3×"));
    more();
    fireEvent.click(screen.getByRole("switch", { name: /Show the current step/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save…" }));
    const [chosenContext, request, expected] = started(job);
    expect(chosenContext).toMatchObject({ sessionId });
    expect(request).toEqual({
      sessionId,
      fromMs: 0,
      toMs: 60_000,
      speed: 3,
      skipIdle: true,
      captions: true,
      overlays: true,
      size: { w: 1280, h: 800 },
      fps: 15,
      quality: "low",
      format: "mp4",
    });
    expect(expected).toMatchObject({ durationS: 20, fitted: { bytes: expect.any(Number) } });
  });

  it("takes any speed, typed or stepped", async () => {
    const job = fakeJob();
    await show(job);
    fireEvent.click(speed("Custom"));
    const field = screen.getByRole("textbox", { name: "Custom speed" });
    fireEvent.change(field, { target: { value: "2.5x" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect((field as HTMLInputElement).value).toBe("2.5");
    fireEvent.click(screen.getByRole("button", { name: "Faster" }));
    expect((field as HTMLInputElement).value).toBe("3");
    fireEvent.change(field, { target: { value: "fast" } });
    fireEvent.blur(field);
    expect((field as HTMLInputElement).value).toBe("3");
    fireEvent.click(screen.getByRole("button", { name: "Save…" }));
    expect(started(job)[1]).toMatchObject({ speed: 3 });
  });

  it("calls changed advanced values Custom, and keeps them for next time", async () => {
    await show(fakeJob());
    more();
    fireEvent.click(screen.getByRole("radio", { name: "720p" }));
    const custom = preset("Custom");
    expect(custom).toHaveProperty("checked", true);
    expect(custom.getAttribute("aria-disabled")).toBeNull();
    expect(screen.getByRole("radiogroup", { name: "Preset" }).textContent).toContain(
      "1280 × 800 · 60 fps · high quality",
    );
    cleanup();
    await show(fakeJob());
    expect(preset("Custom")).toHaveProperty("checked", true);
    fireEvent.click(preset("Fast"));
    expect(JSON.parse(localStorage.getItem("localdot.export.v2") ?? "{}")).toMatchObject({
      preset: "fast",
    });
  });

  it("offers WebM only where the browser can make it", async () => {
    encodable.vp9 = false;
    await show(fakeJob());
    more();
    const webm = screen.getByRole("radio", { name: "WebM" });
    expect(webm.getAttribute("aria-disabled")).toBe("true");
    expect(description(webm)).toContain("This browser can't make WebM video");
  });

  it("says on a touch screen that marking a stretch needs a keyboard", async () => {
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({
          matches: query === "(pointer: coarse)",
          addEventListener() {},
          removeEventListener() {},
        }) as unknown as MediaQueryList,
    );
    await show(fakeJob());
    expect(description(screen.getByRole("radio", { name: "Selection" }))).toContain(
      "On a keyboard, press I and O on the timeline to mark a stretch",
    );
  });

  it("keeps a long export off the download path and says which browsers can save it", async () => {
    vi.stubGlobal("showSaveFilePicker", undefined);
    const job = fakeJob();
    const hours = context({}, 2 * 60 * 60_000);
    hours.activity = [{ from: 0, to: 2 * 60 * 60_000_000 }];
    const panel = await show(job, hours);
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

  it("names the saved file with its size, length and how long it took", async () => {
    const job = fakeJob({
      phase: "saved",
      file: {
        name: "localdot-2026-10-08-0901.mp4",
        bytes: 3.25 * 1024 * 1024,
        durationS: 34,
        ms: 4200,
      },
    });
    const panel = await show(job);
    expect(screen.getByRole("status").textContent).toContain("Video saved");
    expect(panel.textContent).toContain("localdot-2026-10-08-0901.mp4");
    expect(panel.textContent).toContain("3.3 MB · 0:34 video · made in 0:05");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(job.reset).toHaveBeenCalledOnce();
  });

  it("saves a finished download only when asked", async () => {
    vi.stubGlobal("showSaveFilePicker", undefined);
    const job = fakeJob({
      phase: "ready",
      file: { name: "localdot-2026-10-08-0901.mp4", bytes: 2048, durationS: 0.6, ms: 900 },
    });
    const panel = await show(job);
    expect(panel.textContent).toContain("Your video is ready");
    expect(panel.textContent).toContain("2 KB · 0:01 video");
    fireEvent.click(screen.getByRole("button", { name: "Save video" }));
    expect(job.save).toHaveBeenCalledOnce();
  });

  it("offers a downloaded video again, since the browser's prompt may have been cancelled", async () => {
    vi.stubGlobal("showSaveFilePicker", undefined);
    const job = fakeJob({
      phase: "downloaded",
      file: { name: "localdot-2026-10-08-0901.mp4", bytes: 2048, durationS: 0.6, ms: 900 },
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

describe("Export video made by the host", () => {
  const ready = (maxPixels = { mp4: 2560 * 1600, webm: 0 }): HostExportsView => ({
    host: { state: "ready", maxPixels },
    exports: [],
  });

  it("asks the host to make it, with what the host can encode, not this browser", async () => {
    vi.stubGlobal("VideoEncoder", undefined);
    encodable.widths = new Set();
    const job = fakeJob();
    const panel = await show(job, screenContext(), undefined, fakeHost(ready()));
    expect(screen.getByRole("radiogroup", { name: "Preset" }).textContent).toContain(
      "2560 × 1600 · 60 fps · sharpest",
    );
    expect(panel.textContent).not.toContain("keep it open");
    more();
    expect(description(screen.getByRole("radio", { name: "WebM" }))).toContain(
      "This computer can't make WebM video",
    );
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(job.start).toHaveBeenCalledOnce();
  });

  it("waits while the host checks what it can make", async () => {
    await show(
      fakeJob(),
      context(),
      undefined,
      fakeHost({ host: { state: "checking", maxPixels: { mp4: 0, webm: 0 } }, exports: [] }),
    );
    const button = screen.getByRole("button", { name: "Export" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(description(button)).toContain("Checking what this computer can make");
  });

  it("says the video goes on if the page closes, and that a page-made one needs the page", async () => {
    const running = { phase: "exporting" as const, done: 420, total: 1000, startedAt: 0 };
    const host = await show(fakeJob({ ...running, where: "host" }));
    expect(host.textContent).toContain("It keeps going if you close this page or switch apps.");
    cleanup();
    const page = await show(fakeJob({ ...running, where: "page" }));
    expect(page.textContent).toContain(
      "This page makes the video, so keep it open until it's saved.",
    );
    cleanup();
    const options = await show(fakeJob());
    expect(options.textContent).toContain("keep it open until it's saved");
  });

  it("says a host's video is waiting while another is made first", async () => {
    const panel = await show(
      fakeJob({ phase: "exporting", where: "host", waiting: true, startedAt: performance.now() }),
    );
    expect(panel.textContent).toContain("Waiting to start");
    expect(panel.textContent).not.toContain("Getting the recording ready");
  });

  it("asks the host again each time the sheet opens", async () => {
    const host = fakeHost();
    await show(fakeJob(), context(), undefined, host);
    expect(host.refresh).toHaveBeenCalledOnce();
  });

  it("shows a host's video getting ready before its frames are counted", async () => {
    const panel = await show(
      fakeJob({ phase: "exporting", where: "host", startedAt: performance.now() }),
    );
    expect(panel.textContent).toContain("Getting the recording ready");
    expect(
      screen.getByRole("progressbar", { name: "Export progress" }).hasAttribute("aria-valuenow"),
    ).toBe(false);
  });
});
