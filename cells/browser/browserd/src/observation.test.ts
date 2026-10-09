import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserControl } from "./control.ts";
import type { BrowserGeometrySnapshot } from "./geometry.ts";
import type { BrowserNative } from "./native.ts";
import {
  BROWSER_OBSERVATION_TIMEOUT_MS,
  BrowserObservation,
  type BrowserObservationOptions,
} from "./observation.ts";
import { projectBrowser } from "./perception.ts";
import { type BrowserDocument, BrowserTargetError } from "./targets.ts";

const identity = {
  browserCellId: "01J00000000000000000000001",
  parentCellId: "01J00000000000000000000002",
  instance: "11111111-1111-4111-8111-111111111111",
};
const owner = { sessionId: "01J00000000000000000000003", generation: 1 };
const permit = { ...identity, revision: 1, requestId: "01J00000000000000000000004", owner };
const signal = () => new AbortController().signal;
const privateCanary = "private-field-canary";

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("missing fixture value");
  return value;
}

function geometry(scale: 1 | 2 = 2): BrowserGeometrySnapshot {
  return {
    document: { tabId: "tab", revision: 1, frame: false },
    content: [20 * scale, 100 * scale, 1000 * scale, 600 * scale],
    width: 800,
    height: 480,
    factor: 1.25 * scale,
    scrollX: 0,
    scrollY: 12000,
    focus: "page",
  };
}

function metadata(scale: 1 | 2 = 2) {
  const strings = [
    "root",
    "#document",
    "HTML",
    "BODY",
    "BUTTON",
    "INPUT",
    "TEXTAREA",
    "#text",
    "IFRAME",
    "type",
    "password",
    "",
    privateCanary,
    "CANVAS",
  ];
  const snapshot = {
    strings,
    documents: [
      {
        frameId: 0,
        scrollOffsetX: 0,
        scrollOffsetY: 12000,
        nodes: {
          nodeName: [1, 2, 3, 4, 5, 6, 7, 5, 8, 13],
          parentIndex: [-1, 0, 1, 2, 2, 2, 5, 2, 2, 2],
          backendNodeId: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
          attributes: [[], [], [], [], [], [], [], [9, 10], [], []],
          inputValue: { index: [4, 7], value: [12, 11] },
          textValue: { index: [5], value: [12] },
        },
        layout: {
          nodeIndex: [2, 3, 4, 5, 6, 7, 8, 9],
          bounds: [
            [0, 0, 800, 20000],
            [10, 12020, 100, 30],
            [10, 12070, 100, 30],
            [10, 12120, 100, 50],
            [10, 12120, 80, 10],
            [10, 12200, 100, 30],
            [200, 12020, 200, 200],
            [500, 12020, 200, 200],
          ],
        },
      },
    ],
  };
  const accessibility = {
    nodes: [
      {
        ignored: false,
        backendDOMNodeId: 13,
        role: { value: "button" },
        name: { value: "Continue" },
      },
      ...[14, 15, 17].map((backendDOMNodeId) => ({
        ignored: false,
        backendDOMNodeId,
        role: { value: "textbox" },
        name: { value: privateCanary },
        value: { value: privateCanary },
      })),
      {
        ignored: false,
        backendDOMNodeId: 16,
        role: { value: "StaticText" },
        name: { value: privateCanary },
      },
      {
        ignored: false,
        backendDOMNodeId: 18,
        role: { value: "image" },
        name: { value: privateCanary },
      },
      {
        ignored: false,
        backendDOMNodeId: 19,
        role: { value: "image" },
        name: { value: privateCanary },
      },
      {
        ignored: false,
        backendDOMNodeId: 500,
        role: { value: "button" },
        name: { value: "foreign frame canary" },
      },
    ],
  };
  const root = required(snapshot.documents[0]);
  root.scrollOffsetX *= geometry(scale).factor;
  root.scrollOffsetY *= geometry(scale).factor;
  root.layout.bounds = root.layout.bounds.map((bounds) =>
    bounds.map((value) => value * geometry(scale).factor),
  );
  return { snapshot, accessibility };
}

async function setup(scale: 1 | 2 = 2) {
  const control = new BrowserControl({
    ...identity,
    clearSelections: async () => {},
    secretPages: async () => [],
    reload: async () => {},
  });
  await control.set({ ...permit, holder: "agent" });
  const state = {
    geometry: geometry(scale),
    ...metadata(scale),
    stale: false,
    secretFocused: false,
    hit: 13,
    hitFrame: "root",
  };
  const abort = new AbortController();
  const hooks = new Map<string, () => void | Promise<void>>();
  const counts = new Map<string, number>();
  const checkpoint = async (name: string) => {
    const count = (counts.get(name) ?? 0) + 1;
    counts.set(name, count);
    await hooks.get(`${name}:${count}`)?.();
  };
  const check = vi.fn((_document: BrowserDocument) => {
    if (state.stale) throw new Error(privateCanary);
  });
  const command = vi.fn(async (_document: BrowserDocument, method: string) => {
    await checkpoint(method);
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root" } } };
    if (method === "DOMSnapshot.captureSnapshot") return state.snapshot;
    if (method === "Accessibility.getFullAXTree") return state.accessibility;
    if (method === "DOM.getNodeForLocation")
      return { backendNodeId: state.hit, frameId: state.hitFrame };
    throw new Error(privateCanary);
  });
  const capture = {
    masked: vi.fn(async (_mask: unknown, _signal: AbortSignal | undefined): Promise<Buffer> => {
      await checkpoint("capture");
      return Buffer.from("masked-frame");
    }),
  };
  const nativeCommand = vi.fn(async () => {
    await checkpoint("pointer");
    return { x: 20 * scale, y: 140 * scale };
  });
  const options: BrowserObservationOptions = {
    control,
    targets: { command, check },
    scale,
    geometry: {
      point: (snapshot, x, y) => ({
        native: {
          x: snapshot.content[0] + x * snapshot.factor,
          y: snapshot.content[1] + y * snapshot.factor,
        },
        screenshot: {
          x: (snapshot.content[0] + x * snapshot.factor) / scale,
          y: (snapshot.content[1] + y * snapshot.factor) / scale,
        },
        document: { x: Math.round(x + snapshot.scrollX), y: Math.round(y + snapshot.scrollY) },
      }),
      read: vi.fn(async () => {
        await checkpoint("geometry");
        return structuredClone(state.geometry);
      }),
    },
    secrets: {
      secretFocused: vi.fn(async () => {
        await checkpoint("focus");
        return state.secretFocused;
      }),
    },
    native: { command: nativeCommand as unknown as BrowserNative["command"] },
    capture,
  };
  const observation = new BrowserObservation(options);
  return { control, state, abort, hooks, counts, capture, options, observation, nativeCommand };
}

afterEach(() => vi.useRealTimers());

function readingPage(f: Awaited<ReturnType<typeof setup>>) {
  const strings = f.state.snapshot.strings;
  const value = (text: string) => {
    strings.push(text);
    return strings.length - 1;
  };
  const root = Object.assign(required(f.state.snapshot.documents[0]), {
    documentURL: value(`https://example.test/article?code=${privateCanary}#${privateCanary}`),
    title: value("Public article"),
  });
  // Chromium uses -1 for nodes with no string value, including ordinary elements.
  const nodes = Object.assign(root.nodes, { nodeValue: root.nodes.nodeName.map(() => -1) });
  nodes.nodeValue[6] = 12;
  const add = (text: string, parent = 2, rendered = true, tag = "#text") => {
    const index = nodes.nodeName.length;
    nodes.nodeName.push(value(tag));
    nodes.nodeValue.push(value(text));
    nodes.parentIndex.push(parent);
    nodes.backendNodeId.push(100 + index);
    nodes.attributes.push([]);
    if (rendered) {
      root.layout.nodeIndex.push(index);
      root.layout.bounds.push([10, 100000 + index * 30, 600, 20]);
    }
    return index;
  };
  const paragraph = add("Entire public paragraph well below the viewport. 你好 world.");
  const hidden = add("Hidden markup canary", 2, false);
  const script = add("", 2, true, "SCRIPT");
  add("script private canary", script);
  add("embedded private canary", 8);
  add(privateCanary, 4);
  return { root, nodes, add, paragraph, hidden, value };
}

describe("admitted full-page reading", () => {
  it("observes an ordinary page with absent node values", async () => {
    const f = await setup();
    readingPage(f);
    await expect(f.observation.observe(permit, "tab", signal())).resolves.toHaveProperty("frame");
    await f.observation.close();
  });

  it("accepts an empty title sentinel and bounds a Unicode title", async () => {
    const f = await setup(),
      p = readingPage(f);
    p.root.title = -1;
    expect((await f.observation.read(permit, "tab", {}, signal())).title).toBe("");
    p.root.title = p.value("a".repeat(2047) + "😀tail");
    const page = await f.observation.read(permit, "tab", {}, signal());
    expect(page.title).toBe("a".repeat(2047));
    expect(page.truncated).toBe(true);
    await f.observation.close();
  });

  it.each([1, 2] as const)(
    "reads offscreen rendered text at scale %s without exposing field or embedded values",
    async (scale) => {
      const f = await setup(scale);
      readingPage(f);
      const { elements, ...page } = await f.observation.read(permit, "tab", {}, signal());
      expect(page).toEqual({
        url: "https://example.test/article",
        title: "Public article",
        text: "Entire public paragraph well below the viewport. 你好 world.",
        outline: "button Continue",
        truncated: false,
      });
      // The controls in view by ref, fields by their kind alone and the password box marked.
      expect(elements?.map(({ box: _box, ...element }) => element)).toEqual([
        { ref: "e13", role: "button", name: "Continue" },
        { ref: "e14", role: "textbox", name: "Input field" },
        { ref: "e15", role: "textbox", name: "Input field" },
        { ref: "e17", role: "textbox", name: "Protected field", secret: true },
      ]);
      expect(JSON.stringify(elements)).not.toContain(privateCanary);
      expect(JSON.stringify(page)).not.toContain(privateCanary);
      expect(f.capture.masked).not.toHaveBeenCalled();
      expect(f.nativeCommand).not.toHaveBeenCalled();
      await f.observation.close();
    },
  );

  it("bounds full-page text without splitting a surrogate pair and marks truncation", async () => {
    const f = await setup(),
      p = readingPage(f);
    p.nodes.nodeValue[p.paragraph] = p.value("a".repeat(499) + "😀tail");
    const page = await f.observation.read(permit, "tab", { maxChars: 500 }, signal());
    expect(page.text).toBe("a".repeat(499));
    expect(page.truncated).toBe(true);
    await f.observation.close();
  });

  it.each(["text", "title"] as const)(
    "reads again a page whose %s changed between its two reads",
    async (kind) => {
      const f = await setup(),
        p = readingPage(f);
      f.hooks.set("DOMSnapshot.captureSnapshot:2", async () => {
        if (kind === "text") p.nodes.nodeValue[p.paragraph] = p.value("Changed content");
        if (kind === "title") p.root.title = p.value("Changed title");
      });
      const page = await f.observation.read(permit, "tab", {}, signal());
      if (kind === "text") expect(page.text).toContain("Changed content");
      else expect(page.title).toBe("Changed title");
      expect(f.counts.get("DOMSnapshot.captureSnapshot")).toBe(4);
      expect(f.capture.masked).not.toHaveBeenCalled();
      await f.observation.close();
    },
  );

  it.each(["control", "document", "secret"] as const)(
    "refuses %s changes between the two page reads",
    async (kind) => {
      const f = await setup(),
        p = readingPage(f);
      f.hooks.set("DOMSnapshot.captureSnapshot:2", async () => {
        if (kind === "document") f.state.stale = true;
        if (kind === "secret") p.root.nodes.inputValue.value[1] = 12;
        if (kind === "control")
          void f.control.set({
            ...identity,
            revision: 2,
            requestId: "01J00000000000000000000005",
            holder: "user",
          });
      });
      await expect(f.observation.read(permit, "tab", {}, signal())).rejects.toThrow(/refused/);
      expect(f.capture.masked).not.toHaveBeenCalled();
      await f.observation.close();
    },
  );

  it("rejects malformed or executable request data before reading any page", async () => {
    const f = await setup();
    readingPage(f);
    const getter = vi.fn(() => 1000);
    const request = Object.defineProperty({}, "maxChars", { get: getter, enumerable: true });
    for (const raw of [
      request,
      { maxChars: 499 },
      { maxChars: 100001 },
      { maxChars: 1000, javascript: "bad" },
    ])
      await expect(f.observation.read(permit, "tab", raw, signal())).rejects.toThrow("request");
    expect(getter).not.toHaveBeenCalled();
    expect(f.counts.size).toBe(0);
    await f.observation.close();
  });

  it("requires complete snapshot text metadata and refuses unsupported document URLs", async () => {
    const f = await setup();
    await expect(f.observation.read(permit, "tab", {}, signal())).rejects.toThrow();
    const p = readingPage(f);
    p.root.documentURL = p.value("file:///private.txt");
    await expect(f.observation.read(permit, "tab", {}, signal())).rejects.toThrow();
    await f.observation.close();
  });
});

describe("private browser perception projection", () => {
  it.each([1, 2] as const)(
    "projects screen-space targets and physical masks at scale %i",
    (scale) => {
      const source = metadata(scale);
      const result = projectBrowser(
        source.snapshot,
        source.accessibility,
        "root",
        geometry(scale),
        scale,
      );
      expect(result.mask.content).toEqual([20 * scale, 100 * scale, 1000 * scale, 600 * scale]);
      expect(result.mask.redactions).toHaveLength(6);
      expect(result.mask.redactions[0]).toEqual([
        Math.floor(32.5 * scale) - 4 * scale,
        Math.floor(187.5 * scale) - 4 * scale,
        Math.ceil(157.5 * scale) - Math.floor(32.5 * scale) + 8 * scale,
        Math.ceil(225 * scale) - Math.floor(187.5 * scale) + 8 * scale,
      ]);
      expect(result.targets).toHaveLength(4);
      expect(result.targets[0]).toMatchObject({
        name: "Continue",
        role: "button",
        source: "ax",
        app: "Chromium",
      });
      expect(result.targets[0]?.bbox?.x).toBe(Math.floor(32.5 * scale) / scale);
      expect(result.targets[0]?.bbox?.y).toBe(125);
      expect(result.targets[3]).toMatchObject({ name: "Protected field", secret: true });
      expect(JSON.stringify(result)).not.toContain(privateCanary);
      expect(JSON.stringify(result)).not.toContain("foreign frame canary");
      expect(Object.isFrozen(result.targets)).toBe(true);
    },
  );

  it("rejects a filled protected field before projecting any data", () => {
    const source = metadata();
    required(source.snapshot.documents[0]).nodes.inputValue.value[1] = 12;
    expect(() =>
      projectBrowser(source.snapshot, source.accessibility, "root", geometry(), 2),
    ).toThrow("secret");
  });

  it.each(["parent", "bounds", "frame", "scroll", "attribute", "columns"])(
    "refuses corrupt %s metadata",
    (kind) => {
      const source = metadata();
      const root = required(source.snapshot.documents[0]);
      if (kind === "parent") root.nodes.parentIndex[3] = 3;
      if (kind === "bounds") required(root.layout.bounds[0])[2] = -1;
      if (kind === "frame") source.snapshot.strings[0] = "foreign";
      if (kind === "scroll") root.scrollOffsetY = 0;
      if (kind === "attribute") root.nodes.attributes[4] = [999999, 11];
      if (kind === "columns") root.layout.bounds.pop();
      expect(() =>
        projectBrowser(source.snapshot, source.accessibility, "root", geometry(), 2),
      ).toThrow("Browser perception refused");
    },
  );

  it("does not expose values even when changing ordinary editable contents", () => {
    const source = metadata();
    const first = projectBrowser(source.snapshot, source.accessibility, "root", geometry(), 2);
    source.snapshot.strings[12] = "other private editable value";
    const second = projectBrowser(source.snapshot, source.accessibility, "root", geometry(), 2);
    expect(first.signature).toBe(second.signature);
    expect(JSON.stringify(second)).not.toContain("other private");
  });

  it("clips visible geometry and omits offscreen targets while retaining mask coverage", () => {
    const source = metadata();
    required(source.snapshot.documents[0]).layout.bounds[1] = [25000, 30050, 250, 75];
    required(source.snapshot.documents[0]).layout.bounds[2] = [-25, 30000, 75, 50];
    const projected = projectBrowser(source.snapshot, source.accessibility, "root", geometry(), 2);
    expect(projected.targets.some((target) => target.name === "Continue")).toBe(false);
    expect(projected.mask.redactions[0]).toEqual([40, 200, 58, 58]);
  });

  it("clips control characters and length in allowed labels without echoing metadata", () => {
    const source = metadata();
    required(source.accessibility.nodes[0]).name.value = `Safe\u202e\n${"x".repeat(100)}`;
    const target = projectBrowser(source.snapshot, source.accessibility, "root", geometry(), 2)
      .targets[0];
    expect(target?.name).toHaveLength(64);
    expect(target?.name).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(Object.keys(target ?? {})).toEqual([
      "point",
      "bbox",
      "source",
      "role",
      "name",
      "app",
      "secret",
    ]);
  });

  it("names the page on every target without its user info, query or fragment", () => {
    const source = metadata();
    const strings = source.snapshot.strings;
    strings.push(`https://me:pw@mail.example.test/compose?draft=${privateCanary}#${privateCanary}`);
    Object.assign(required(source.snapshot.documents[0]), { documentURL: strings.length - 1 });
    const result = projectBrowser(source.snapshot, source.accessibility, "root", geometry(), 2);
    expect(result.targets.map((target) => target.url)).toEqual(
      result.targets.map(() => "https://mail.example.test/compose"),
    );
    expect(result.targetForNode(13)?.url).toBe("https://mail.example.test/compose");
    expect(JSON.stringify(result)).not.toMatch(/private-field|me:pw/);
  });

  it.each([
    "about:blank",
    "chrome-error://chromewebdata/",
    "file:///private.txt",
    "not a page address",
  ])("names no page for %s", (address) => {
    const source = metadata();
    const strings = source.snapshot.strings;
    strings.push(address);
    Object.assign(required(source.snapshot.documents[0]), { documentURL: strings.length - 1 });
    const result = projectBrowser(source.snapshot, source.accessibility, "root", geometry(), 2);
    expect(result.targets.length).toBeGreaterThan(0);
    expect(result.targets.some((target) => "url" in target)).toBe(false);
  });

  it("names only the site of a page whose address is too long to carry", () => {
    const source = metadata();
    const strings = source.snapshot.strings;
    strings.push(`https://mail.example.test/${"a".repeat(2100)}`);
    Object.assign(required(source.snapshot.documents[0]), { documentURL: strings.length - 1 });
    const result = projectBrowser(source.snapshot, source.accessibility, "root", geometry(), 2);
    expect(result.targets[0]?.url).toBe("https://mail.example.test");
  });

  it("unions multiple layout boxes for one node and masks every fragment", () => {
    const source = metadata();
    const root = required(source.snapshot.documents[0]);
    root.layout.nodeIndex.push(4);
    root.layout.bounds.push([300, 30175, 50, 75]);
    const result = projectBrowser(source.snapshot, source.accessibility, "root", geometry(), 2);
    expect(result.mask.redactions).toHaveLength(7);
    expect(result.mask.redactions.at(-1)).toEqual([332, 367, 66, 91]);
    expect(result.targets[1]?.bbox).toEqual({ x: 32.5, y: 187.5, w: 162.5, h: 37.5 });
  });
});

describe("leased browser observation", () => {
  it.each([1, 2] as const)(
    "looks up the actual DOM hit at scale %s without exposing pixels or private metadata",
    async (scale) => {
      const f = await setup(scale);
      const result = await f.observation.lookup(
        permit,
        "tab",
        { kind: "hitTest", point: { x: 95, y: 143.75 } },
        f.abort.signal,
      );
      expect(result.target).toMatchObject({
        name: "Continue",
        role: "button",
        point: { x: 95, y: scale === 1 ? 144 : 143.75 },
      });
      expect(result.window).toBeNull();
      expect(f.options.targets.command).toHaveBeenCalledWith(
        expect.anything(),
        "DOM.getNodeForLocation",
        {
          x: 60,
          y: 12035,
          includeUserAgentShadowDOM: false,
          ignorePointerEventsNone: false,
        },
        expect.any(AbortSignal),
      );
      expect(f.capture.masked).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toMatch(/backend|private-field|foreign frame|image/);
    },
  );
  it("names the page of a target it looks up", async () => {
    const f = await setup();
    readingPage(f);
    const result = await f.observation.lookup(
      permit,
      "tab",
      { kind: "hitTest", point: { x: 95, y: 143.75 } },
      f.abort.signal,
    );
    expect(result.target).toMatchObject({ name: "Continue", url: "https://example.test/article" });
    expect(JSON.stringify(result)).not.toContain(privateCanary);
    await f.observation.close();
  });
  it("finds unique public names and returns no ambiguous or foreign target", async () => {
    const f = await setup();
    expect(
      (
        await f.observation.lookup(
          permit,
          "tab",
          { kind: "find", name: "continue" },
          f.abort.signal,
        )
      ).target?.role,
    ).toBe("button");
    expect(
      (
        await f.observation.lookup(
          permit,
          "tab",
          { kind: "find", name: "Input field" },
          f.abort.signal,
        )
      ).target,
    ).toBeNull();
    f.state.hit = 500;
    expect(
      (
        await f.observation.lookup(
          permit,
          "tab",
          { kind: "hitTest", point: { x: 100, y: 150 } },
          f.abort.signal,
        )
      ).target,
    ).toBeNull();
  });
  it("finds a listed element by its node only while it keeps its listed role and name", async () => {
    const f = await setup();
    const lookup = (request: Record<string, unknown>) =>
      f.observation.lookup(permit, "tab", { kind: "node", ...request }, f.abort.signal);
    expect((await lookup({ node: 13, role: "button", name: "Continue" })).target).toMatchObject({
      role: "button",
      name: "Continue",
    });
    expect((await lookup({ node: 13, role: "button", name: "Cancel" })).target).toBeNull();
    expect((await lookup({ node: 13, role: "link" })).target).toBeNull();
    // A field is listed by its kind alone; the node still finds it.
    expect((await lookup({ node: 14, role: "textbox", name: "Input field" })).target).toMatchObject(
      { name: "Input field" },
    );
    expect((await lookup({ node: 999 })).target).toBeNull();
    await expect(lookup({ node: -1 })).rejects.toThrow();
    await f.observation.close();
  });
  it("names a field by its author's label, never its value, and finds it again by that name", async () => {
    const f = await setup();
    const p = readingPage(f);
    const attributes = (offset: number, pairs: Record<string, string>) => {
      p.nodes.attributes[offset] = Object.entries(pairs).flatMap(([k, v]) => [
        p.value(k),
        p.value(v),
      ]);
    };
    attributes(4, { id: "email" });
    attributes(5, { "aria-label": "Message" });
    const label = p.add("", 2, false, "LABEL");
    attributes(label, { for: "email" });
    p.add(" Email\n address ", label, false);
    const read = await f.observation.read(permit, "tab", {}, signal());
    expect(read.elements?.map(({ box: _box, ...element }) => element)).toEqual([
      { ref: "e13", role: "button", name: "Continue" },
      { ref: "e14", role: "textbox", name: "Email address" },
      { ref: "e15", role: "textbox", name: "Message" },
      { ref: "e17", role: "textbox", name: "Protected field", secret: true },
    ]);
    expect(JSON.stringify(read)).not.toContain(privateCanary);
    const lookup = (name: string) =>
      f.observation.lookup(
        permit,
        "tab",
        { kind: "node", node: 14, role: "textbox", name },
        f.abort.signal,
      );
    expect((await lookup("Email address")).target).toMatchObject({ name: "Email address" });
    // A label that holds a field of its own never names one.
    p.add("", label, false, "INPUT");
    expect((await lookup("Email address")).target).toBeNull();
    expect((await lookup("Input field")).target).toMatchObject({ name: "Input field" });
    await f.observation.close();
  });
  it("gives a box's tick with the element found by its node", async () => {
    const f = await setup();
    const button = required(f.state.accessibility.nodes[0]);
    Object.assign(button, { properties: [{ name: "checked", value: { value: "true" } }] });
    const found = await f.observation.lookup(
      permit,
      "tab",
      { kind: "node", node: 13, role: "button", name: "Continue" },
      f.abort.signal,
    );
    expect(found.target).toMatchObject({ checked: "true" });
    await f.observation.close();
  });
  // A page that adds frames or rewrites its URL as it settles changes its document mid-read.
  it.each(["read", "observe"] as const)(
    "reads again a page whose document changed under the %s",
    async (kind) => {
      const f = await setup();
      readingPage(f);
      f.hooks.set("DOMSnapshot.captureSnapshot:1", () => {
        throw new BrowserTargetError("stale");
      });
      const result =
        kind === "read"
          ? f.observation.read(permit, "tab", { maxChars: 1000 }, signal())
          : f.observation.observe(permit, "tab", signal());
      await expect(result).resolves.toBeDefined();
      expect(f.counts.get("DOMSnapshot.captureSnapshot")).toBeGreaterThan(2);
      await f.observation.close();
    },
  );
  it("stops reading a page that keeps changing", async () => {
    const f = await setup();
    readingPage(f);
    for (let count = 1; count <= 100; count++)
      f.hooks.set(`DOMSnapshot.captureSnapshot:${count}`, () => {
        throw new BrowserTargetError("stale");
      });
    await expect(f.observation.observe(permit, "tab", signal())).rejects.toThrow("unavailable");
    expect(f.counts.get("DOMSnapshot.captureSnapshot")).toBeLessThan(10);
    await f.observation.close();
  });
  it("reads actual accessibility focus and invalidates a focus change during the query", async () => {
    const f = await setup();
    const first = required(f.state.accessibility.nodes[0]);
    Object.assign(first, { properties: [{ name: "focused", value: { value: true } }] });
    expect(
      (await f.observation.lookup(permit, "tab", { kind: "focused" }, f.abort.signal)).target?.name,
    ).toBe("Continue");
    f.hooks.set("Accessibility.getFullAXTree:4", () => {
      Object.assign(first, { properties: [] });
      Object.assign(required(f.state.accessibility.nodes[1]), {
        properties: [{ name: "focused", value: { value: true } }],
      });
    });
    const moved = await f.observation.lookup(permit, "tab", { kind: "focused" }, f.abort.signal);
    expect(moved.target?.name).not.toBe("Continue");
    expect(JSON.stringify(moved)).not.toContain(privateCanary);
    expect(f.counts.get("Accessibility.getFullAXTree")).toBe(6);
  });
  it("looks again at a point whose hit changed during hit revalidation", async () => {
    const f = await setup();
    f.hooks.set("DOM.getNodeForLocation:1", async () => {
      f.hooks.set("DOM.getNodeForLocation:2", () => {
        f.state.hit = 14;
      });
    });
    await expect(
      f.observation.lookup(
        permit,
        "tab",
        { kind: "hitTest", point: { x: 100, y: 150 } },
        f.abort.signal,
      ),
    ).resolves.toHaveProperty("target");
    expect(f.counts.get("DOM.getNodeForLocation")).toBe(4);
    expect(f.capture.masked).not.toHaveBeenCalled();
  });
  it.each(["takeover", "abort", "geometry", "frame"] as const)(
    "refuses a %s during hit revalidation",
    async (change) => {
      const f = await setup();
      f.hooks.set("DOM.getNodeForLocation:1", async () => {
        if (change === "takeover") {
          void f.control.set({
            ...identity,
            requestId: "01J00000000000000000000005",
            revision: 2,
            holder: "user",
          });
        }
        if (change === "abort") f.abort.abort();
        if (change === "geometry")
          f.state.geometry = { ...f.state.geometry, scrollX: f.state.geometry.scrollX + 1 };
        if (change === "frame") f.state.hitFrame = "foreign-frame";
      });
      await expect(
        f.observation.lookup(
          permit,
          "tab",
          { kind: "hitTest", point: { x: 100, y: 150 } },
          f.abort.signal,
        ),
      ).rejects.toThrow("Browser observation refused");
      expect(f.capture.masked).not.toHaveBeenCalled();
    },
  );
  it("refuses secret focus and request accessors before returning target data", async () => {
    const f = await setup();
    f.state.secretFocused = true;
    await expect(
      f.observation.lookup(permit, "tab", { kind: "focused" }, f.abort.signal),
    ).rejects.toThrow("secret");
    const getter = vi.fn();
    await expect(
      f.observation.lookup(
        permit,
        "tab",
        Object.defineProperty({}, "kind", { get: getter, enumerable: true }),
        f.abort.signal,
      ),
    ).rejects.toThrow("request");
    expect(getter).not.toHaveBeenCalled();
  });
  it.each([1, 2] as const)(
    "returns only masked pixels and projected data at scale %i",
    async (scale) => {
      const fixture = await setup(scale);
      const result = await fixture.observation.observe(permit, "tab", fixture.abort.signal);
      expect(result.frame).toMatchObject({
        width: 1280,
        height: 800,
        image: Buffer.from("masked-frame").toString("base64"),
        pointer: { x: 20, y: 140 },
        windows: [],
      });
      expect(result.frame.frameId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
      expect(result.targets).toHaveLength(4);
      expect(fixture.capture.masked).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain(privateCanary);
      await fixture.observation.close();
      await fixture.control.close();
    },
  );

  it.each([
    "geometry:1",
    "focus:1",
    "Page.getFrameTree:1",
    "DOMSnapshot.captureSnapshot:1",
    "Accessibility.getFullAXTree:1",
    "capture:1",
    "pointer:1",
    "geometry:2",
    "focus:2",
    "Page.getFrameTree:2",
    "DOMSnapshot.captureSnapshot:2",
    "Accessibility.getFullAXTree:2",
  ])("fences takeover at %s and publishes nothing", async (boundary) => {
    const fixture = await setup();
    let takeover: Promise<unknown> | undefined;
    fixture.hooks.set(boundary, () => {
      takeover = fixture.control.set({
        ...identity,
        revision: 2,
        requestId: "01J00000000000000000000005",
        holder: "user",
      });
    });
    await expect(fixture.observation.observe(permit, "tab", fixture.abort.signal)).rejects.toThrow(
      "aborted",
    );
    await takeover;
    if (
      [
        "geometry:1",
        "focus:1",
        "Page.getFrameTree:1",
        "DOMSnapshot.captureSnapshot:1",
        "Accessibility.getFullAXTree:1",
      ].includes(boundary)
    )
      expect(fixture.capture.masked).not.toHaveBeenCalled();
    expect(fixture.control.holder).toBe("user");
    await fixture.observation.close();
  });

  it.each(["geometry", "mask"])(
    "captures again after a late %s change and publishes only the later frame",
    async (kind) => {
      const fixture = await setup();
      fixture.hooks.set("capture:1", () => {
        if (kind === "geometry") fixture.state.geometry = { ...fixture.state.geometry, width: 799 };
        if (kind === "mask")
          required(required(fixture.state.snapshot.documents[0]).layout.bounds[2])[0] = 50;
      });
      await expect(
        fixture.observation.observe(permit, "tab", fixture.abort.signal),
      ).resolves.toHaveProperty("frame");
      expect(fixture.capture.masked).toHaveBeenCalledTimes(2);
      await fixture.control.close();
    },
  );

  it.each(["secret", "focus", "document"])(
    "discards captured pixels after a late %s change",
    async (kind) => {
      const fixture = await setup();
      fixture.hooks.set("capture:1", () => {
        if (kind === "secret")
          required(fixture.state.snapshot.documents[0]).nodes.inputValue.value[1] = 12;
        if (kind === "focus") fixture.state.secretFocused = true;
        if (kind === "document") fixture.state.stale = true;
      });
      await expect(
        fixture.observation.observe(permit, "tab", fixture.abort.signal),
      ).rejects.toThrow("Browser observation refused");
      expect(fixture.capture.masked).toHaveBeenCalledTimes(1);
      await fixture.control.close();
    },
  );

  it.each(["chrome", "unknown"] as const)("refuses %s focus before capture", async (focus) => {
    const fixture = await setup();
    fixture.state.geometry = { ...fixture.state.geometry, focus };
    await expect(fixture.observation.observe(permit, "tab", signal())).rejects.toThrow(
      "unavailable",
    );
    expect(fixture.capture.masked).not.toHaveBeenCalled();
    await fixture.control.close();
  });

  it("refuses busy work, aborts pending capture on close and releases its lease", async () => {
    const fixture = await setup();
    const entered = Promise.withResolvers<void>();
    fixture.capture.masked.mockImplementation(
      async (_mask, abort) =>
        new Promise<Buffer>((_resolve, reject) => {
          entered.resolve();
          abort?.addEventListener("abort", () => reject(new Error(privateCanary)), { once: true });
        }),
    );
    const pending = expect(fixture.observation.observe(permit, "tab", signal())).rejects.toThrow(
      "aborted",
    );
    await entered.promise;
    await expect(fixture.observation.observe(permit, "tab", signal())).rejects.toThrow("busy");
    await fixture.observation.close();
    await pending;
    await fixture.control.close();
    await expect(fixture.observation.observe(permit, "tab", signal())).rejects.toThrow("closed");
  });

  it("expires a stalled real dispatch without retaining its lease", async () => {
    vi.useFakeTimers();
    const fixture = await setup();
    const entered = Promise.withResolvers<void>();
    fixture.capture.masked.mockImplementation(
      async (_mask, abort) =>
        new Promise<Buffer>((_resolve, reject) => {
          entered.resolve();
          abort?.addEventListener("abort", () => reject(new Error(privateCanary)), { once: true });
        }),
    );
    const pending = expect(fixture.observation.observe(permit, "tab", signal())).rejects.toThrow(
      "aborted",
    );
    await entered.promise;
    await vi.advanceTimersByTimeAsync(BROWSER_OBSERVATION_TIMEOUT_MS + 1);
    await pending;
    await fixture.control.close();
  });

  it("rejects wrong authority and inert-data violations before any inspection", async () => {
    const fixture = await setup();
    const getter = vi.fn(() => permit.owner);
    const accessor = Object.defineProperty({ ...permit }, "owner", {
      get: getter,
      enumerable: true,
    });
    for (const invalid of [
      { ...permit, revision: 2 },
      { ...permit, owner: { ...owner, generation: 2 } },
      accessor,
      new Proxy(permit, {
        ownKeys: () => {
          throw new Error(privateCanary);
        },
      }),
    ])
      await expect(fixture.observation.observe(invalid, "tab", signal())).rejects.toThrow(
        "Browser observation refused",
      );
    expect(getter).not.toHaveBeenCalled();
    expect(fixture.options.geometry.read).not.toHaveBeenCalled();
    await fixture.control.close();
  });

  it("copies the authority before asynchronous observations", async () => {
    const fixture = await setup();
    const mutable = structuredClone(permit);
    fixture.hooks.set("geometry:1", () => {
      mutable.owner.generation = 999;
      mutable.revision = 999;
    });
    await expect(fixture.observation.observe(mutable, "tab", signal())).resolves.toHaveProperty(
      "frame.width",
      1280,
    );
    await fixture.control.close();
  });

  it("rejects aborted and foreign-document requests without private cause text", async () => {
    const fixture = await setup();
    fixture.abort.abort();
    await expect(fixture.observation.observe(permit, "tab", fixture.abort.signal)).rejects.toThrow(
      "aborted",
    );
    await expect(fixture.observation.observe(permit, "foreign", signal())).rejects.toThrow("stale");
    fixture.capture.masked.mockRejectedValue(new Error(privateCanary));
    await expect(fixture.observation.observe(permit, "tab", signal())).rejects.toThrow(
      /^Browser observation refused: unavailable$/u,
    );
    await fixture.control.close();
  });
});
