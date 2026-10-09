// @vitest-environment jsdom
import { type LocalDotEvent, msToMicros } from "@localdot/protocol";
import { emptyModel, foldEvents } from "@localdot/stage";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../lib/api.ts";
import { ExportSheet } from "./ExportSheet.tsx";
import type { ExportContext } from "./export-context.ts";
import { planExport } from "./export-plan.ts";
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
vi.mock("./export-plan.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./export-plan.ts")>();
  return { ...actual, planExport: vi.fn(actual.planExport) };
});

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
const field = (name: string) => screen.getByRole<HTMLInputElement>("textbox", { name });
const times = () => [field("Start time").value, field("End time").value];

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
  it("opens on the trim tool, then the presets, each with its size and wait, from the kit's controls", async () => {
    const panel = await show(fakeJob());
    expect(panel.querySelector("select, input[type=file], progress, meter")).toBe(null);
    const presets = screen.getByRole("radiogroup", { name: "Preset" });
    const [first, second] = panel.querySelectorAll("[role=radiogroup], [role=slider]");
    expect(first).toBe(screen.getByRole("slider", { name: "Start" }));
    expect(
      screen.getByRole("radiogroup", { name: "Range" }).compareDocumentPosition(presets) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(second).toBe(screen.getByRole("slider", { name: "End" }));
    expect(preset("Quality")).toHaveProperty("checked", true);
    expect(presets.textContent).toContain("1920 × 1200 · 60 fps · sharpest");
    expect(presets.textContent).toContain("1280 × 800 · 15 fps · smallest");
    const custom = preset("Custom");
    expect(custom.getAttribute("aria-disabled")).toBe("true");
    expect(description(custom)).toContain("Set under More options");
    // Every row keeps a slot for its estimate, so nothing moves as they are worked out.
    expect(presets.querySelectorAll(".export-estimate")).toHaveLength(4);
    expect(presets.querySelectorAll(".export-estimate[data-hidden]")).toHaveLength(1);
    for (const name of ["Range", "Speed"])
      expect(screen.getByRole("radiogroup", { name })).toBeTruthy();
    expect(times()).toEqual(["0:00.0", "1:00.0"]);
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
    await show(fakeJob(), context({ selection: { fromMs: 5_000, toMs: 35_000 } }));
    const on = screen.getByRole("radio", { name: "Selection" });
    expect(on.getAttribute("aria-checked")).toBe("true");
    expect(times()).toEqual(["0:05.0", "0:35.0"]);
    fireEvent.click(screen.getByRole("radio", { name: "This step" }));
    expect(times()).toEqual(["0:15.0", "0:17.5"]);
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

  it("makes Showcase with dot under the picture, at the recording's own pace, sized with its band", async () => {
    const job = fakeJob();
    const panel = await show(job);
    expect(screen.getByRole("radiogroup", { name: "Preset" }).textContent).toContain(
      "1920 × 1410 · 60 fps · with dot",
    );
    fireEvent.click(speed("3×"));
    more();
    fireEvent.click(screen.getByRole("switch", { name: /Skip idle/ }));
    fireEvent.click(preset("Showcase"));
    expect(speed("1×").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: /Skip idle/ })).toHaveProperty("checked", true);
    expect(screen.getByRole("switch", { name: /Show dot/ })).toHaveProperty("checked", true);
    expect(
      screen.getByRole("radio", { name: "Under the picture" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(panel.querySelector(".export-preview")?.getAttribute("data-dot")).toBe("under");
    fireEvent.click(screen.getByRole("button", { name: "Save…" }));
    expect(started(job)[1]).toMatchObject({
      speed: 1,
      skipIdle: true,
      captions: false,
      dot: "under",
      size: { w: 1920, h: 1410 },
      fps: 60,
      quality: "high",
    });
  });

  it("shows Showcase's row as Showcase makes it, whatever speed and Skip idle are set", async () => {
    rate.fps = 30;
    await show(fakeJob(), screenContext());
    const row = () => preset("Showcase").closest("label")?.textContent;
    const made = row();
    expect(made).toContain("1920 × 1410 · 30 fps · with dot");
    fireEvent.click(speed("3×"));
    more();
    fireEvent.click(screen.getByRole("switch", { name: /Skip idle/ }));
    expect(row()).toBe(made);
    fireEvent.click(preset("Showcase"));
    expect(row()).toBe(made);
  });

  it("puts dot on the picture on request, and remembers where", async () => {
    const job = fakeJob();
    const panel = await show(job);
    expect(screen.queryByRole("radio", { name: "On the picture" })).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: /Show dot/ }));
    // Quality's picture with dot under it is what Showcase makes.
    expect(preset("Showcase")).toHaveProperty("checked", true);
    fireEvent.click(screen.getByRole("radio", { name: "On the picture" }));
    expect(preset("Custom")).toHaveProperty("checked", true);
    expect(description(preset("Custom"))).toContain(
      "1920 × 1200 · 60 fps · high quality · with dot",
    );
    expect(panel.querySelector(".export-preview")?.getAttribute("data-dot")).toBe("over");
    fireEvent.click(screen.getByRole("button", { name: "Save…" }));
    expect(started(job)[1]).toMatchObject({ dot: "over", size: { w: 1920, h: 1200 } });
    cleanup();
    await show(fakeJob());
    const over = () => screen.getByRole("radio", { name: "On the picture" });
    expect(over().getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("switch", { name: /Show dot/ }));
    expect(preset("Quality")).toHaveProperty("checked", true);
    fireEvent.click(screen.getByRole("switch", { name: /Show dot/ }));
    expect(over().getAttribute("aria-checked")).toBe("true");
  });

  it("keeps Quality and Fast clean of dot and the step caption", async () => {
    const job = fakeJob();
    await show(job);
    fireEvent.click(preset("Showcase"));
    fireEvent.click(preset("Fast"));
    expect(screen.getByRole("switch", { name: /Show dot/ })).toHaveProperty("checked", false);
    fireEvent.click(screen.getByRole("button", { name: "Save…" }));
    const request = started(job)[1] as Record<string, unknown>;
    expect(request).toMatchObject({ captions: false, size: { w: 1280, h: 800 } });
    expect("dot" in request).toBe(false);
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

  it("previews the caption the video will show: dot's line at the playhead", async () => {
    await show(fakeJob(), context({ model: reportModel() }));
    expect(document.querySelector(".export-preview-caption")?.textContent).toBe(
      "Opening the monthly report to read the sales table",
    );
  });
});

// dot opens a report at 0:15 and the task ends at 1:00.
function reportModel() {
  const at = (type: string, tMs: number, data: object, step?: string, seq = 0) =>
    ({
      v: 1,
      id: sessionId,
      seq,
      t: msToMicros(tMs),
      agent: "main",
      ...(step ? { step } : {}),
      type,
      data,
    }) as LocalDotEvent;
  const model = foldEvents(emptyModel(), [
    at("session.start", 0, { screen: { w: 1280, h: 800, scale: 1 }, os: "linux" }, undefined, 0),
    at("message.user", 0, { messageId: sessionId, text: "Sum the sales", kind: "task" }, "", 1),
    at("agent.state", 15_000, { state: "acting" }, undefined, 2),
    at(
      "step.start",
      15_000,
      { kind: "gui", intent: "Opening the monthly report to read the sales table" },
      "s1",
      3,
    ),
    at(
      "action.intent",
      15_010,
      { verb: "click", label: "Open monthly-report.ods", risk: "none" },
      "s1",
      4,
    ),
    at("action.result", 15_400, { ok: true }, "s1", 5),
    at("step.end", 15_450, { status: "ok" }, "s1", 6),
    at("agent.state", 15_500, { state: "thinking" }, undefined, 7),
  ]);
  model.ended = { t: 60_000, reason: "done" };
  return model;
}

// The strip's film spans 600 px from x = 100: on a minute's recording, a pixel is 100 ms.
function layOut(panel: HTMLElement) {
  const film = panel.querySelector<HTMLElement>(".trim-film");
  if (!film) throw new Error("no strip");
  const box = (left: number, width: number) =>
    ({
      left,
      right: left + width,
      width,
      top: 0,
      bottom: 48,
      height: 48,
      x: left,
      y: 0,
    }) as DOMRect;
  film.getBoundingClientRect = () => box(100, 600);
  const [from, to] = screen.getAllByRole("slider");
  if (!from || !to) throw new Error("no handles");
  return { from, to };
}

const press = (target: Element, type: string, clientX: number) =>
  fireEvent(target, new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 }));

function withSteps(starts: number[], endMs = 60_000): ExportContext {
  const base = context();
  base.model.steps = starts.map((startT, index) => ({
    id: `s${index}`,
    kind: "gui",
    startT,
    endT: starts[index + 1] ?? endMs,
    status: "ok",
  }));
  return base;
}

describe("Trimming the video", () => {
  it("drags a handle one to one from where it was taken, and exports that part", async () => {
    const job = fakeJob();
    const panel = await show(job);
    const { from, to } = layOut(panel);
    // Taken 5 px left of its edge, the handle keeps that offset under the pointer.
    press(from, "pointerdown", 95);
    expect(panel.querySelector(".export-preview[data-held]")).not.toBe(null);
    press(from, "pointermove", 395);
    expect(times()).toEqual(["0:30.0", "1:00.0"]);
    expect(panel.querySelector(".export-preview-time")?.textContent).toBe("Start0:30.0");
    press(from, "pointerup", 395);
    expect(panel.querySelector(".export-preview[data-held]")).toBe(null);
    press(to, "pointerdown", 705);
    press(to, "pointermove", 655);
    press(to, "pointerup", 655);
    expect(times()).toEqual(["0:30.0", "0:55.0"]);
    expect(panel.textContent).toMatch(/0:25 video · about/);
    fireEvent.click(screen.getByRole("button", { name: "Save…" }));
    expect(started(job)[1]).toMatchObject({ fromMs: 30_000, toMs: 55_000 });
    expect(started(job)[2]).toMatchObject({ durationS: 25 });
  });

  it("previews the handle that is held, even before it moves", async () => {
    const panel = await show(fakeJob(), context({ model: reportModel() }));
    const caption = () => panel.querySelector(".export-preview-caption")?.textContent;
    expect(caption()).toBe("Opening the monthly report to read the sales table");
    const { to } = layOut(panel);
    press(to, "pointerdown", 705);
    expect(panel.querySelector(".export-preview-time")?.textContent).toBe("End1:00.0");
    expect(caption()).toBe("Done.");
  });

  it("works out no estimates again while a handle is only held", async () => {
    const panel = await show(fakeJob());
    const { from } = layOut(panel);
    vi.mocked(planExport).mockClear();
    press(from, "pointerdown", 95);
    expect(panel.querySelector(".export-preview[data-held]")).not.toBe(null);
    expect(planExport).not.toHaveBeenCalled();
  });

  it("keeps the handles apart and inside the recording", async () => {
    const panel = await show(fakeJob());
    const { from, to } = layOut(panel);
    press(from, "pointerdown", 100);
    press(from, "pointermove", 900);
    press(from, "pointerup", 900);
    expect(times()).toEqual(["0:59.5", "1:00.0"]);
    press(to, "pointerdown", 700);
    press(to, "pointermove", -50);
    press(to, "pointerup", -50);
    expect(times()).toEqual(["0:59.5", "1:00.0"]);
    press(from, "pointerdown", 695);
    press(from, "pointermove", 0);
    press(from, "pointerup", 0);
    expect(times()).toEqual(["0:00.0", "1:00.0"]);
  });

  it("snaps a dragged handle to dot's step edges while Snap to steps is on", async () => {
    const panel = await show(fakeJob(), withSteps([0, 15_500, 23_000]));
    const { from } = layOut(panel);
    expect(panel.querySelectorAll(".trim-step")).toHaveLength(3);
    press(from, "pointerdown", 100);
    // 0:15.0 is 5 px from the step that starts at 0:15.5.
    press(from, "pointermove", 250);
    expect(times()[0]).toBe("0:15.5");
    expect(panel.querySelectorAll(".trim-step[data-snapped]")).toHaveLength(2);
    press(from, "pointermove", 220);
    expect(times()[0]).toBe("0:12.0");
    expect(panel.querySelector(".trim-step[data-snapped]")).toBe(null);
    press(from, "pointerup", 220);
    fireEvent.click(screen.getByRole("switch", { name: "Snap to steps" }));
    press(from, "pointerdown", 220);
    press(from, "pointermove", 250);
    press(from, "pointerup", 250);
    expect(times()[0]).toBe("0:15.0");
    expect(JSON.parse(localStorage.getItem("localdot.export.v2") ?? "{}")).toMatchObject({
      snap: false,
    });
  });

  it("keeps a press on a handle from the sheet's own drag", async () => {
    const panel = await show(fakeJob());
    const { from } = layOut(panel);
    const sheet = vi.fn();
    panel.addEventListener("pointerdown", sheet);
    press(from, "pointerdown", 95);
    press(from, "pointerup", 95);
    expect(sheet).not.toHaveBeenCalled();
  });

  it("takes typed times, kept inside the recording, and puts back what it can't read", async () => {
    const job = fakeJob();
    await show(job);
    fireEvent.change(field("End time"), { target: { value: "0:45" } });
    fireEvent.keyDown(field("End time"), { key: "Enter" });
    fireEvent.change(field("Start time"), { target: { value: "12.25" } });
    fireEvent.blur(field("Start time"));
    expect(times()).toEqual(["0:12.3", "0:45.0"]);
    fireEvent.change(field("Start time"), { target: { value: "soon" } });
    fireEvent.blur(field("Start time"));
    fireEvent.change(field("End time"), { target: { value: "5:00" } });
    fireEvent.keyDown(field("End time"), { key: "Enter" });
    expect(times()).toEqual(["0:12.3", "1:00.0"]);
    fireEvent.click(screen.getByRole("button", { name: "Save…" }));
    expect(started(job)[1]).toMatchObject({ fromMs: 12_300, toMs: 60_000 });
  });

  it("nudges a focused handle with the keyboard", async () => {
    await show(fakeJob(), withSteps([0, 15_500, 23_000]));
    const start = screen.getByRole("slider", { name: "Start" });
    fireEvent.keyDown(start, { key: "ArrowRight" });
    fireEvent.keyDown(start, { key: "ArrowRight", shiftKey: true });
    expect(start.getAttribute("aria-valuetext")).toBe("0:01.1");
    fireEvent.keyDown(start, { key: "ArrowRight", altKey: true });
    expect(times()[0]).toBe("0:15.5");
    const end = screen.getByRole("slider", { name: "End" });
    fireEvent.keyDown(end, { key: "Home" });
    expect(times()).toEqual(["0:15.5", "0:16.0"]);
    expect(end.getAttribute("aria-valuemin")).toBe("16000");
  });

  it("sets both handles from Whole, This step and Selection, and shows which one they hold", async () => {
    await show(fakeJob(), context({ selection: { fromMs: 5_000, toMs: 35_000 } }));
    const range = screen.getByRole("radiogroup", { name: "Range" });
    const checked = () =>
      within(range)
        .getAllByRole("radio")
        .filter((radio) => radio.getAttribute("aria-checked") === "true")
        .map((radio) => radio.textContent);
    expect(checked()).toEqual(["Selection"]);
    fireEvent.keyDown(screen.getByRole("slider", { name: "End" }), { key: "ArrowLeft" });
    expect(checked()).toEqual([]);
    fireEvent.click(within(range).getByRole("radio", { name: "Whole" }));
    expect(times()).toEqual(["0:00.0", "1:00.0"]);
    expect(checked()).toEqual(["Whole"]);
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
