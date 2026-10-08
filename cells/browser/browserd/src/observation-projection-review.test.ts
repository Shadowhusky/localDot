import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserCapture } from "./capture.ts";
import { BrowserControl } from "./control.ts";
import type { BrowserGeometrySnapshot } from "./geometry.ts";
import type { BrowserNative } from "./native.ts";
import { BrowserObservation, type BrowserObservationOptions } from "./observation.ts";
import { projectBrowser } from "./perception.ts";

const privateValue = "editable-only-private-canary";
const geometry: BrowserGeometrySnapshot = {
  document: { tabId: "tab", revision: 1, frame: false },
  content: [0, 100, 1280, 700],
  width: 1280,
  height: 700,
  factor: 1,
  scrollX: 0,
  scrollY: 0,
  focus: "page",
};

function fixture() {
  // Stable <h2><span contenteditable>privateValue</span></h2>, plus an ordinary button.
  const snapshot = {
    strings: [
      "root",
      "#document",
      "HTML",
      "BODY",
      "H2",
      "SPAN",
      "#text",
      "BUTTON",
      "contenteditable",
      "true",
      privateValue,
    ],
    documents: [
      {
        frameId: 0,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
        nodes: {
          nodeName: [1, 2, 3, 4, 5, 6, 7],
          parentIndex: [-1, 0, 1, 2, 3, 4, 2],
          backendNodeId: [1, 2, 3, 4, 5, 6, 7],
          attributes: [[], [], [], [], [8, 9], [], []],
          inputValue: { index: [], value: [] },
          textValue: { index: [5], value: [10] },
        },
        layout: {
          nodeIndex: [3, 4, 5, 6],
          bounds: [
            [30, 40, 200, 40],
            [30, 40, 200, 40],
            [30, 40, 190, 30],
            [300, 40, 80, 30],
          ],
        },
      },
    ],
  };
  const ax = {
    nodes: [
      {
        ignored: false,
        backendDOMNodeId: 4,
        role: { value: "heading" },
        name: { value: privateValue },
      },
      {
        ignored: false,
        backendDOMNodeId: 5,
        role: { value: "textbox" },
        name: { value: privateValue },
        value: { value: privateValue },
      },
      {
        ignored: false,
        backendDOMNodeId: 6,
        role: { value: "StaticText" },
        name: { value: privateValue },
      },
      {
        ignored: false,
        backendDOMNodeId: 7,
        role: { value: "button" },
        name: { value: "Continue" },
      },
    ],
  };
  return { snapshot, ax };
}

describe("independent observation editable projection", () => {
  it("P1 preserves ordinary visible content when no editable region is present", () => {
    const { snapshot, ax } = fixture();
    ax.nodes[0]!.name.value = "Public heading";
    snapshot.documents[0]!.nodes.attributes[4] = [];
    const result = projectBrowser(snapshot, ax, "root", geometry, 1);
    expect(result.targets.some((target) => target.name === "Public heading")).toBe(true);
    expect(result.targets.some((target) => target.name === "Continue")).toBe(true);
    expect(result.mask.redactions).toHaveLength(0);
  });

  it("I1 must not publish editable descendant contents through an ancestor AX name", () => {
    const { snapshot, ax } = fixture();
    const result = projectBrowser(snapshot, ax, "root", geometry, 1);
    expect(result.mask.redactions).toHaveLength(2);
    expect(result.targets.some((target) => target.name === "Continue")).toBe(true);
    expect(result.targets.some((target) => target.name === "Input field")).toBe(true);
    expect(JSON.stringify(result.targets)).not.toContain(privateValue);
  });

  it("P2 malformed duplicate backend identities cannot alias a blocked node", () => {
    const { snapshot, ax } = fixture();
    snapshot.documents[0]!.nodes.backendNodeId[6] = 5;
    expect(() => projectBrowser(snapshot, ax, "root", geometry, 1)).toThrow("metadata");
  });

  it("P3 physical snapshot units use zoom/display exactly once and retain partial-edge coverage", () => {
    const { snapshot, ax } = fixture();
    snapshot.documents[0]!.scrollOffsetY = 25000;
    snapshot.documents[0]!.layout.bounds = snapshot.documents[0]!.layout.bounds.map(
      ([x = 0, y = 0, w = 0, h = 0]) => [x * 2.5, y * 2.5 + 25000, w * 2.5, h * 2.5],
    );
    const projected = projectBrowser(
      snapshot,
      ax,
      "root",
      {
        ...geometry,
        content: [0, 200, 2560, 1400],
        width: 1024,
        height: 560,
        factor: 2.5,
        scrollY: 10000,
      },
      2,
    );
    expect(projected.targets.find((target) => target.name === "Continue")?.bbox).toEqual({
      x: 375,
      y: 150,
      w: 100,
      h: 37.5,
    });
    expect(projected.mask.redactions[0]).toEqual([67, 292, 516, 116]);
  });
});

const identity = {
  browserCellId: "01J00000000000000000000001",
  parentCellId: "01J00000000000000000000002",
  instance: "11111111-1111-4111-8111-111111111111",
};
const permit = {
  ...identity,
  revision: 1,
  requestId: "01J00000000000000000000004",
  owner: { sessionId: "01J00000000000000000000003", generation: 1 },
};
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  vi.useRealTimers();
});
function imagePacket(id: number) {
  const packet = Buffer.alloc(38);
  packet.writeUInt32BE(id);
  packet.writeUInt32BE(30, 4);
  packet.write("RIFF", 8);
  packet.writeUInt32LE(22, 12);
  packet.write("WEBPVP8 ", 16);
  packet.writeUInt32LE(10, 24);
  packet.set([0x9d, 0x01, 0x2a], 31);
  packet.writeUInt16LE(1280, 34);
  packet.writeUInt16LE(800, 36);
  return packet;
}
async function ownerFixture() {
  const control = new BrowserControl({
    ...identity,
    clearSelections: async () => {},
    secretPages: async () => [],
    reload: async () => {},
  });
  await control.set({ ...permit, holder: "agent" });
  const input = new PassThrough();
  const output = new PassThrough();
  const requested = Promise.withResolvers<Buffer>();
  const packets: Buffer[] = [];
  input.on("data", (chunk: Buffer) => {
    packets.push(Buffer.from(chunk));
    requested.resolve(Buffer.from(chunk));
  });
  const fatal = vi.fn(() => {
    void control.close();
  });
  const capture = new BrowserCapture({ input, output, onFatal: fatal });
  output.write(Buffer.from("LDCP"));
  await capture.ready;
  const metadata = fixture();
  metadata.ax.nodes[0]!.name.value = "Public heading";
  const state = { stale: false, afterCapture: false, shifted: false };
  const check = () => {
    if (state.stale) throw new Error(privateValue);
  };
  const options: BrowserObservationOptions = {
    control,
    capture,
    scale: 1,
    geometry: {
      read: async () => ({
        ...geometry,
        content: state.shifted ? [1, 100, 1279, 700] : geometry.content,
      }),
    },
    secrets: { secretFocused: async () => false },
    targets: {
      check,
      command: async (_document, method) => {
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root" } } };
        if (method === "DOMSnapshot.captureSnapshot") return metadata.snapshot;
        if (method === "Accessibility.getFullAXTree") return metadata.ax;
        throw new Error(privateValue);
      },
    },
    native: {
      command: (async () => {
        state.afterCapture = true;
        return { x: 10, y: 200 };
      }) as BrowserNative["command"],
    },
  };
  const observation = new BrowserObservation(options);
  closers.push(async () => {
    await observation.close();
    capture.close();
    await control.close();
  });
  return {
    control,
    capture,
    observation,
    metadata,
    state,
    options,
    packets,
    output,
    fatal,
    requested: requested.promise,
  };
}

describe("independent observation capture ownership", () => {
  it("O1 positive returns only the nonce-matched masked frame and safe pointer after rechecks", async () => {
    const f = await ownerFixture();
    const pending = f.observation.observe(permit, "tab", new AbortController().signal);
    const packet = await f.requested;
    expect(packet.readUInt32BE(0)).toBe(0);
    expect(packet.readUInt32BE(4)).toBe(1);
    expect(packet.readUInt32BE(32)).toBe(2);
    f.output.write(imagePacket(1));
    const result = await pending;
    expect(result.frame.image).toBe(imagePacket(1).subarray(8).toString("base64"));
    expect(result.frame.pointer).toEqual({ x: 10, y: 200 });
    expect(f.state.afterCapture).toBe(true);
    expect(f.fatal).not.toHaveBeenCalled();
  });
  it.each(["takeover", "abort", "close"])(
    "O2 %s retires pending masked capture without late output or a lease cycle",
    async (reason) => {
      const f = await ownerFixture();
      const abort = new AbortController();
      const pending = f.observation.observe(permit, "tab", abort.signal).then(
        () => "published",
        () => "refused",
      );
      await f.requested;
      let transition: Promise<unknown> = Promise.resolve();
      if (reason === "takeover")
        transition = f.control
          .set({
            ...identity,
            revision: 2,
            requestId: "01J00000000000000000000005",
            holder: "user",
          })
          .catch(() => {});
      if (reason === "abort") abort.abort();
      if (reason === "close") transition = f.observation.close();
      f.output.emit("data", imagePacket(1));
      expect(await pending).toBe("refused");
      await transition;
      expect(f.fatal).toHaveBeenCalledOnce();
      expect(f.control.holder).toBe("user");
      expect(f.state.afterCapture).toBe(false);
      expect(f.capture.alive).toBe(false);
    },
  );
  it.each(["document", "geometry", "mask"])(
    "O3 %s changing after a successful capture prevents any publication",
    async (change) => {
      const f = await ownerFixture();
      const pending = f.observation.observe(permit, "tab", new AbortController().signal).then(
        () => "published",
        () => "refused",
      );
      await f.requested;
      if (change === "document") f.state.stale = true;
      if (change === "geometry") f.state.shifted = true;
      if (change === "mask") f.metadata.snapshot.documents[0]!.layout.bounds[1]![0] = 60;
      f.output.write(imagePacket(1));
      expect(await pending).toBe("refused");
      expect(f.packets).toHaveLength(1);
    },
  );
  it("O4 an inert rejected authority consumes neither inspection nor capture work", async () => {
    const f = await ownerFixture();
    const invoked = vi.fn();
    const hostile = Object.defineProperty({}, "owner", { enumerable: true, get: invoked });
    await expect(
      f.observation.observe(hostile, "tab", new AbortController().signal),
    ).rejects.toThrow("request");
    expect(invoked).not.toHaveBeenCalled();
    expect(f.packets).toHaveLength(0);
  });
});
