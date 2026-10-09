import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ComputerAction,
  DEFAULT_AUTONOMY,
  type HitTestResult,
  msToMicros,
  type PageElement,
  type Point,
  type Rect,
  type Target,
  ulid,
} from "@localdot/protocol";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { FakeOrchestrator } from "../../cells/testing/fake-orchestrator.ts";
import { NO_STREAM } from "../../cells/types.ts";
import { DesktopdRegistry } from "../../desktopd/registry.ts";
import { FakeDesktopd } from "../../desktopd/testing/fake-desktopd.ts";
import { EventLog } from "../../event-log.ts";
import { FrameStore } from "../../gateway/frames.ts";
import { ActionGateway } from "../../gateway/gateway.ts";
import { DEFAULT_ONSET_TABLE } from "../../gateway/onset-table.ts";
import { keepPolicy } from "../../gateway/ring-onset.ts";
import { FramePng } from "../frame-png.ts";
import { redactor } from "../redact.ts";
import { AgentSession } from "../session.ts";
import { browserActTool } from "./browser-act.ts";
import { computerTool, UNCHANGED } from "./computer.ts";
import type { ToolCallContext, ToolDeps } from "./deps.ts";

const grey = (paint?: Rect) => {
  const pixels = Buffer.alloc(1280 * 800, 100);
  if (paint)
    for (let y = paint.y; y < paint.y + paint.h; y++)
      for (let x = paint.x; x < paint.x + paint.w; x++) pixels[y * 1280 + x] = 220;
  return sharp(pixels, { raw: { width: 1280, height: 800, channels: 1 } })
    .png()
    .toBuffer();
};

const field = (point: Point, name: string): Target => ({
  point,
  bbox: { x: point.x - 100, y: point.y - 15, w: 200, h: 30 },
  source: "ax",
  role: "text",
  name,
  app: "Mousepad",
  window: "notes",
});
const web = (point: Point, name: string, role = "button"): Target => ({
  point,
  bbox: { x: point.x - 40, y: point.y - 15, w: 80, h: 30 },
  source: "dom",
  role,
  name,
  app: "Chromium",
  window: "Mail - Chromium",
  url: "https://mail.example/inbox",
});
const hit = (target: Target | null): HitTestResult => ({ target, window: 77, ms: 1 });

// A desktop at scale 1 through the real action gateway: the agent's inputs are authorized by the
// same classifier and approval path as any pixel action, against frames the fake desktop serves.
async function setup() {
  const home = mkdtempSync(join(tmpdir(), "localdot-fast-actions-"));
  let now = 10_000_000;
  const clock = { nowMicros: () => now };
  const log = new EventLog(home, clock);
  const cells = new FakeOrchestrator();
  const fake = new FakeDesktopd({
    type: (body) => {
      const count = [...(body as { text: string }).text].length;
      return {
        progress: [{ count, pressMono: 60_000 }],
        result: { done: true, count, firstPressMono: 60_000, injector: "xtest", armedMono: 59_000 },
      };
    },
  });
  const registry = new DesktopdRegistry(cells, clock, fake.fetchImpl);
  const cellId = ulid();
  cells.emit({
    id: cellId,
    state: "ready",
    scale: 1,
    createdAt: new Date().toISOString(),
    stream: { ...NO_STREAM, connection: "none", viewers: 0 },
  });
  cells.endpointsById.set(cellId, {
    desktopd: { baseUrl: "http://127.0.0.1:1", token: fake.token },
    stream: { baseUrl: "http://127.0.0.1:2", authorization: "Basic x" },
  });
  const frames = new FrameStore(home);
  const gateway = new ActionGateway({
    eventLog: log,
    cells,
    registry,
    onset: DEFAULT_ONSET_TABLE,
    ringOnset: keepPolicy(DEFAULT_ONSET_TABLE),
    frames,
    now: clock.nowMicros,
    sleep: async (ms, signal) => {
      signal?.throwIfAborted();
      now += msToMicros(ms);
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  const sessionId = log.createSession("fast actions");
  const session = new AgentSession(sessionId, cellId, "task", log, DEFAULT_AUTONOMY);
  const asks = vi.spyOn(session, "requestApproval").mockResolvedValue("approve");
  const signal = new AbortController().signal;
  const ctx = {
    session,
    generation: { id: 1, signal },
    lease: { generation: { id: 1, signal }, signal, check() {}, finish() {} },
    check() {},
    callId: ulid(),
    step: ulid(),
    redact: redactor([]),
    signal,
  } as unknown as ToolCallContext;
  const framePng = new FramePng(frames);
  const deps = {
    gateway,
    png: {
      png: async (_session: string, frameId: string) => Buffer.from(`png:${frameId}`),
      same: framePng.same.bind(framePng),
    },
    scaleOf: () => 1,
  } as unknown as ToolDeps;
  const setFrames = async (image: Buffer) => {
    fake.script.observe = () => ({
      frameId: ulid(),
      width: 1280,
      height: 800,
      image: image.toString("base64"),
      pointer: { x: 640, y: 400 },
      windows: [],
    });
  };
  await setFrames(await grey());
  const basis = (await gateway.observe({ source: "manual", sessionId, cellId, signal })).frameId;
  // The model was sent this screen.
  session.lastFrameId = basis;
  const inputs = () => fake.calls.filter((c) => c.path === "/input" || c.path === "/type");
  const steps = () => log.read(sessionId).filter((e) => e.type === "step.start");
  // The web browser's screen showing `tabId`, its input going to this desktop.
  const onTab = (tabId: string) => {
    vi.spyOn(session, "screens", "get").mockReturnValue({
      browserAccess: () => ({ tabId }),
    } as unknown as AgentSession["screens"]);
    Object.assign(ctx, {
      screen: { selection: { screen: "browser" } },
      nativeScreen: {
        cellId,
        parentCellId: cellId,
        scale: 1,
        device: registry.for(cellId),
        signal,
        check() {},
        stream: () => ({ ...NO_STREAM, connection: "none", viewers: 0 }),
        subscribe: () => () => {},
      },
    });
  };
  return { fake, ctx, deps, session, asks, basis, setFrames, inputs, steps, onTab };
}

const images = (content: { type: string }[]) => content.filter((c) => c.type === "image");
const texts = (content: { type: string; text?: string }[]) =>
  content.flatMap((c) => (c.type === "text" ? [c.text ?? ""] : [])).join("\n");

describe("a batch of computer inputs", () => {
  it("runs its steps in order, each as its own step, with one screenshot at the end", async () => {
    const s = await setup();
    s.fake.script.hitTest = (p) => hit(field(p, "Name"));
    s.fake.script.focused = () => hit(field({ x: 300, y: 200 }, "Name"));
    const batch: ComputerAction = {
      action: "batch",
      steps: [
        { action: "click", point: { x: 300, y: 200 }, button: "left", count: 1 },
        { action: "type", text: "Robin" },
        { action: "key", keys: ["Tab"] },
        { action: "type", text: "Hale" },
      ],
      basedOn: s.basis,
    };
    // Something far from every step changes, so the batch ends on a new screen.
    await s.setFrames(await grey({ x: 1000, y: 700, w: 40, h: 40 }));
    const result = await computerTool(s.deps, s.ctx, batch);
    expect(result.ok).toBe(true);
    expect(s.inputs().map((c) => c.path)).toEqual(["/input", "/type", "/input", "/type"]);
    expect(images(result.content)).toHaveLength(1);
    expect(texts(result.content)).toContain("Typed 5 characters");
    // The first step's Activity step belongs to the call; each further step opens its own.
    expect(s.steps()).toHaveLength(3);
    expect(s.asks).not.toHaveBeenCalled();
  });

  it("stops before a step that needs the user's approval, without asking or doing it", async () => {
    const s = await setup();
    const send = { x: 600, y: 500 };
    s.fake.script.hitTest = (p) =>
      hit(p.x === send.x && p.y === send.y ? web(p, "Send") : field(p, "Message"));
    s.fake.script.focused = () => hit(field({ x: 300, y: 200 }, "Message"));
    await s.setFrames(await grey({ x: 1000, y: 700, w: 40, h: 40 }));
    const result = await computerTool(s.deps, s.ctx, {
      action: "batch",
      steps: [
        { action: "click", point: { x: 300, y: 200 }, button: "left", count: 1 },
        { action: "type", text: "On my way" },
        { action: "click", point: send, button: "left", count: 1 },
      ],
      basedOn: s.basis,
    });
    expect(result.ok).toBe(false);
    expect(texts(result.content)).toContain(
      "Stopped before step 3 of 3 (click): it needs the user's approval or control, so do it as its own action. Steps 1 to 2 were done.",
    );
    expect(s.asks).not.toHaveBeenCalled();
    expect(s.inputs().map((c) => c.path)).toEqual(["/input", "/type"]);
    expect(images(result.content)).toHaveLength(1);
    // Nothing of step 3 ran, so its Activity step ends as cancelled, not failed.
    expect(s.ctx.stepCancelled).toBe(true);
  });

  it("stops at a step whose target changed since the screenshot it was chosen on", async () => {
    const s = await setup();
    s.fake.script.hitTest = (p) => hit(field(p, "Field"));
    // Something new drew itself over the second point after the model's screenshot.
    await s.setFrames(await grey({ x: 880, y: 580, w: 40, h: 40 }));
    const result = await computerTool(s.deps, s.ctx, {
      action: "batch",
      steps: [
        { action: "click", point: { x: 300, y: 200 }, button: "left", count: 1 },
        { action: "click", point: { x: 900, y: 600 }, button: "left", count: 1 },
        { action: "key", keys: ["Return"] },
      ],
      basedOn: s.basis,
    });
    expect(result).toMatchObject({ ok: false, cancelled: "stale" });
    expect(texts(result.content)).toContain("Stopped at step 2 of 3 (click). Step 1 was done.");
    expect(s.inputs()).toHaveLength(1);
    expect(images(result.content)).toHaveLength(1);
  });

  it("refuses steps outside a batch", async () => {
    const s = await setup();
    const result = await computerTool(s.deps, s.ctx, {
      action: "click",
      point: { x: 1, y: 1 },
      steps: [{ action: "key", keys: ["Return"] }],
    });
    expect(result.ok).toBe(false);
    expect(s.inputs()).toHaveLength(0);
  });
});

describe("screenshot economy", () => {
  it("says the screen did not change instead of sending the same screenshot again", async () => {
    const s = await setup();
    s.fake.script.hitTest = (p) => hit(field(p, "Empty space"));
    const same = await computerTool(s.deps, s.ctx, {
      action: "click",
      point: { x: 300, y: 200 },
      button: "left",
      count: 1,
      basedOn: s.basis,
    });
    expect(images(same.content)).toHaveLength(0);
    expect(texts(same.content)).toContain(UNCHANGED);
    await s.setFrames(await grey({ x: 0, y: 0, w: 50, h: 50 }));
    const changed = await computerTool(s.deps, s.ctx, {
      action: "click",
      point: { x: 300, y: 200 },
      button: "left",
      count: 1,
      basedOn: s.basis,
    });
    expect(images(changed.content)).toHaveLength(1);
  });

  it("compares with the newest screen sent in the turn, not the turn's screenshot", async () => {
    const s = await setup();
    s.fake.script.hitTest = (p) => hit(field(p, "Edit"));
    s.fake.script.focused = () => hit(field({ x: 300, y: 200 }, "Edit"));
    // The first action opens a menu; the second, on the same turn's screenshot, closes it again.
    await s.setFrames(await grey({ x: 280, y: 210, w: 200, h: 300 }));
    const opened = await computerTool(s.deps, s.ctx, {
      action: "click",
      point: { x: 300, y: 200 },
      button: "left",
      count: 1,
      basedOn: s.basis,
    });
    expect(images(opened.content)).toHaveLength(1);
    await s.setFrames(await grey());
    const closed = await computerTool(s.deps, s.ctx, {
      action: "key",
      keys: ["Escape"],
      basedOn: s.basis,
    });
    expect(texts(closed.content)).not.toContain(UNCHANGED);
    expect(images(closed.content)).toHaveLength(1);
  });

  it("always sends the screen to a model with no screenshot to compare it with", async () => {
    const s = await setup();
    const result = await computerTool(s.deps, s.ctx, { action: "wait", ms: 10 });
    expect(images(result.content)).toHaveLength(1);
  });
});

describe("browser_act", () => {
  const send: PageElement = {
    ref: "e42",
    role: "button",
    name: "Send",
    box: { x: 560, y: 285, w: 80, h: 30 },
  };
  const listed = (s: Awaited<ReturnType<typeof setup>>, ...elements: PageElement[]) => {
    s.session.pageRefs = {
      cellId: s.session.cellId,
      url: "https://mail.example/inbox",
      elements: new Map(elements.map((e) => [e.ref, e])),
    };
  };
  const findSend = (s: Awaited<ReturnType<typeof setup>>, at: Point, url?: string) => {
    s.fake.script.find = (req) => {
      const { node, role, name } = req as { node?: number; role?: string; name?: string };
      const target = { ...web(at, "Send"), ...(url ? { url } : {}) };
      return hit(node === 42 && role === "button" && name === "Send" ? target : null);
    };
  };

  it("acts on a listed element where it is now, approved like a click there", async () => {
    const s = await setup();
    listed(s, send);
    const now = { x: 700, y: 450 };
    findSend(s, now);
    s.fake.script.hitTest = (p) => hit(web(p, "Send"));
    const result = await browserActTool(s.deps, s.ctx, { action: "click", ref: "e42" });
    expect(result.ok).toBe(true);
    // Sending is consequential under Balanced: the user approves the click on Send.
    expect(s.asks).toHaveBeenCalledTimes(1);
    expect(s.inputs()).toHaveLength(1);
    expect(s.inputs()[0]?.body).toMatchObject({ input: { kind: "click", at: now } });
  });

  it("never acts on a ref read on another page", async () => {
    const s = await setup();
    listed(s, send);
    // Another site's node with the same number, role and name.
    findSend(s, { x: 700, y: 450 }, "https://shop.example/cart");
    s.fake.script.hitTest = (p) => hit(web(p, "Send"));
    const result = await browserActTool(s.deps, s.ctx, { action: "click", ref: "e42" });
    expect(result.ok).toBe(false);
    expect(texts(result.content)).toContain("Read the page again");
    expect(s.inputs()).toHaveLength(0);
  });

  it("never acts on a ref read on another tab", async () => {
    const s = await setup();
    s.session.pageRefs = {
      cellId: s.session.cellId,
      tabId: "tab-a",
      url: "https://mail.example/inbox",
      elements: new Map([[send.ref, send]]),
    };
    s.onTab("tab-b");
    findSend(s, { x: 700, y: 450 });
    s.fake.script.hitTest = (p) => hit(web(p, "Send"));
    const result = await browserActTool(s.deps, s.ctx, { action: "click", ref: "e42" });
    expect(result.ok).toBe(false);
    expect(texts(result.content)).toContain("e42 is not in this screen's last page read");
    expect(s.asks).not.toHaveBeenCalled();
    expect(s.inputs()).toHaveLength(0);
  });

  it("never clicks what covers a listed element since the read", async () => {
    const s = await setup();
    listed(s, send);
    findSend(s, { x: 700, y: 450 });
    // A banner over the button takes whatever lands on its point.
    s.fake.script.hitTest = (p) =>
      hit({ ...web(p, "Accept cookies"), bbox: { x: 0, y: 400, w: 1280, h: 120 } });
    const result = await browserActTool(s.deps, s.ctx, { action: "click", ref: "e42" });
    expect(result.ok).toBe(false);
    expect(texts(result.content)).toContain("Read the page again");
    expect(s.asks).not.toHaveBeenCalled();
    expect(s.inputs()).toHaveLength(0);
  });

  it("clicks a listed element through the text inside it", async () => {
    const s = await setup();
    listed(s, send);
    const now = { x: 700, y: 450 };
    findSend(s, now);
    s.fake.script.hitTest = (p) =>
      hit({ ...web(p, "Send", "StaticText"), bbox: { x: 680, y: 440, w: 40, h: 20 } });
    const result = await browserActTool(s.deps, s.ctx, { action: "click", ref: "e42" });
    expect(result.ok).toBe(true);
    expect(s.inputs()[0]?.body).toMatchObject({ input: { kind: "click", at: now } });
  });

  it("never fills a password field", async () => {
    const s = await setup();
    listed(s, { ...send, ref: "e7", role: "textbox", name: "Password", secret: true });
    const result = await browserActTool(s.deps, s.ctx, {
      action: "fill",
      ref: "e7",
      text: "hunter2",
    });
    expect(result.ok).toBe(false);
    expect(texts(result.content)).toContain("ask_user");
    expect(s.inputs()).toHaveLength(0);
  });

  it("never types into a password field by any act or by its coordinate", async () => {
    const s = await setup();
    listed(s, { ...send, ref: "e7", role: "textbox", name: "Password", secret: true });
    for (const act of [
      { action: "select" as const, ref: "e7", text: "hunter2" },
      { action: "press" as const, ref: "e7", text: "ctrl+v" },
    ]) {
      const result = await browserActTool(s.deps, s.ctx, act);
      expect(texts(result.content)).toContain("ask_user");
    }
    const password = { ...web({ x: 600, y: 300 }, "Password", "textbox"), secret: true };
    s.fake.script.hitTest = () => hit(password);
    s.fake.script.focused = () => hit(password);
    const byPoint = await browserActTool(s.deps, s.ctx, {
      action: "fill",
      coordinate: [600, 300],
      text: "hunter2",
      basedOn: s.basis,
    });
    expect(byPoint.ok).toBe(false);
    expect(texts(byPoint.content)).toContain("ask_user");
    expect(s.asks).not.toHaveBeenCalled();
    expect(s.inputs()).toHaveLength(0);
  });

  it("falls back to the coordinate, checked against its screenshot, when the ref is stale", async () => {
    const s = await setup();
    listed(s, { ...send, name: "Archive" });
    s.fake.script.hitTest = (p) => hit(field(p, "Archive"));
    const result = await browserActTool(s.deps, s.ctx, {
      action: "click",
      ref: "e42",
      coordinate: [600, 300],
      basedOn: s.basis,
    });
    expect(result.ok).toBe(true);
    expect(texts(result.content)).toContain("e42 is no longer as you read it");
    expect(s.inputs()[0]?.body).toMatchObject({ input: { kind: "click", at: { x: 600, y: 300 } } });
  });

  it("does not use the coordinate when the screen changed around it since its screenshot", async () => {
    const s = await setup();
    listed(s, { ...send, name: "Archive" });
    s.fake.script.hitTest = (p) => hit(field(p, "Archive"));
    await s.setFrames(await grey({ x: 580, y: 280, w: 40, h: 40 }));
    for (const ref of ["e42", undefined]) {
      const result = await browserActTool(s.deps, s.ctx, {
        action: "click",
        ...(ref ? { ref } : {}),
        coordinate: [600, 300],
        basedOn: s.basis,
      });
      expect(result).toMatchObject({ ok: false, cancelled: "stale" });
    }
    expect(s.inputs()).toHaveLength(0);
  });

  it("asks for a new read when the ref is stale and there is no coordinate", async () => {
    const s = await setup();
    listed(s, send);
    const gone = await browserActTool(s.deps, s.ctx, { action: "click", ref: "e42" });
    expect(gone.ok).toBe(false);
    expect(texts(gone.content)).toContain("Read the page again");
    const unknown = await browserActTool(s.deps, s.ctx, { action: "click", ref: "e43" });
    expect(texts(unknown.content)).toContain("not in this screen's last page read");
    expect(s.inputs()).toHaveLength(0);
  });

  it("ticks a box by how it is now, not how it was read", async () => {
    const s = await setup();
    const box = (checked: "true" | "false") => {
      s.fake.script.find = () =>
        hit({ ...web({ x: 600, y: 300 }, "Notify me", "checkbox"), checked });
      s.fake.script.hitTest = (p) => hit({ ...web(p, "Notify me", "checkbox"), checked });
    };
    // Read unticked, ticked since: nothing to do.
    listed(s, { ...send, ref: "e9", role: "checkbox", name: "Notify me", checked: "false" });
    box("true");
    const already = await browserActTool(s.deps, s.ctx, { action: "check", ref: "e9" });
    expect(already).toMatchObject({ ok: true, content: [{ text: "e9 is already checked." }] });
    expect(s.inputs()).toHaveLength(0);
    // Read ticked, unticked since: one click ticks it.
    listed(s, { ...send, ref: "e9", role: "checkbox", name: "Notify me", checked: "true" });
    box("false");
    const ticked = await browserActTool(s.deps, s.ctx, { action: "check", ref: "e9" });
    expect(ticked.ok).toBe(true);
    expect(s.inputs()).toHaveLength(1);
  });

  it("fills a field: click, select all, type, then Return", async () => {
    const s = await setup();
    listed(s, { ...send, ref: "e5", role: "textbox", name: "Search" });
    s.fake.script.find = () => hit(web({ x: 400, y: 120 }, "Search", "textbox"));
    s.fake.script.hitTest = (p) => hit(web(p, "Search", "textbox"));
    s.fake.script.focused = () => hit(web({ x: 400, y: 120 }, "Search", "textbox"));
    const result = await browserActTool(s.deps, s.ctx, {
      action: "fill",
      ref: "e5",
      text: "Dune",
      submit: true,
    });
    expect(result.ok).toBe(true);
    expect(s.inputs().map((c) => (c.body as { input?: { kind: string } }).input?.kind)).toEqual([
      "click",
      "key",
      undefined,
      "key",
    ]);
    expect(s.steps()).toHaveLength(3);
  });
});
