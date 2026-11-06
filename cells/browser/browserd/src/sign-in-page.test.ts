import { describe, expect, it, vi } from "vitest";
import { BrowserSignInPage } from "./sign-in-page.ts";

const DOCUMENT = { tabId: "front", revision: 1, frame: false };
const GEOMETRY = {
  document: DOCUMENT,
  content: [0, 100, 2560, 1400] as const,
  width: 1280,
  height: 700,
  factor: 2,
  scrollX: 0,
  scrollY: 0,
  focus: "page" as const,
};

// A snapshot of inputs, each as [node, attributes].
function snapshot(inputs: readonly [number, Record<string, string>][], hold?: string) {
  const strings: string[] = ["INPUT"];
  const at = (text: string) => {
    strings.push(text);
    return strings.length - 1;
  };
  const attributes = inputs.map(([, attrs]) =>
    Object.entries(attrs).flatMap(([key, value]) => [at(key), at(value)]),
  );
  // What a filled field holds comes with a snapshot, and must never come out of this reader.
  if (hold) at(hold);
  return {
    strings,
    documents: [
      {
        nodes: {
          nodeName: inputs.map(() => 0),
          backendNodeId: inputs.map(([node]) => node),
          attributes,
        },
      },
    ],
  };
}

function page(options: {
  url?: string | null;
  inputs?: readonly [number, Record<string, string>][];
  hidden?: readonly number[];
  covered?: readonly number[];
  hold?: string;
}) {
  const { url = "https://site.example.com/login", inputs = [] } = options;
  const finish = vi.fn();
  const lease = { signal: new AbortController().signal, check: vi.fn(), finish };
  const command = vi.fn(async (_document: unknown, method: string, params: unknown) => {
    const { backendNodeId } = params as { backendNodeId?: number };
    if (method === "DOMSnapshot.captureSnapshot") return snapshot(inputs, options.hold);
    if (method === "DOM.getBoxModel") {
      if (options.hidden?.includes(backendNodeId ?? 0)) throw new Error("no box");
      const top = 100 + (backendNodeId ?? 0) * 40;
      return { model: { content: [50, top, 250, top, 250, top + 30, 50, top + 30] } };
    }
    if (method === "DOM.getNodeForLocation") {
      const { y } = params as { y: number };
      const node = (y - 115) / 40;
      return { backendNodeId: options.covered?.includes(node) ? 999 : node };
    }
    throw new Error(`unexpected ${method}`);
  });
  const reader = new BrowserSignInPage({
    control: { admitManual: vi.fn(() => lease) as never },
    targets: { command: command as never, check: vi.fn() },
    geometry: {
      front: vi.fn(async () => (url === null ? undefined : { tabId: "front", url })),
      read: vi.fn(async () => GEOMETRY as never),
    },
    scale: 2,
  });
  return { reader, command, finish, signal: new AbortController().signal };
}

describe("BrowserSignInPage", () => {
  it("names the tab and site in front and reads no page without being asked for fields", async () => {
    const f = page({});
    expect(await f.reader.read({}, { fields: false }, f.signal)).toEqual({
      tabId: "front",
      origin: "https://site.example.com",
    });
    expect(f.command).not.toHaveBeenCalled();
    expect(f.finish).toHaveBeenCalledOnce();
  });

  it("calls a plain http page no site, so no login goes there", async () => {
    const f = page({
      url: "http://site.example.com/login",
      inputs: [[1, { type: "password" }]],
    });
    expect(await f.reader.read({}, { fields: true }, f.signal)).toEqual({
      tabId: "front",
      origin: null,
    });
    expect(f.command).not.toHaveBeenCalled();
  });

  it("finds a visible password box first, in the units a secret request uses", async () => {
    const f = page({
      inputs: [
        [1, { type: "email", name: "email" }],
        [2, { type: "password", name: "password" }],
      ],
    });
    expect(await f.reader.read({}, { fields: true }, f.signal)).toEqual({
      tabId: "front",
      origin: "https://site.example.com",
      field: { kind: "password", at: { x: 150, y: 245 } },
    });
  });

  it("falls back to the account box when the password box is hidden or covered", async () => {
    for (const blocked of [{ hidden: [2] }, { covered: [2] }]) {
      const f = page({
        inputs: [
          [1, { type: "text", autocomplete: "username" }],
          [2, { type: "password" }],
        ],
        ...blocked,
      });
      expect(await f.reader.read({}, { fields: true }, f.signal)).toMatchObject({
        field: { kind: "account" },
      });
    }
  });

  it("leaves out search boxes, codes and fields that can't be typed in", async () => {
    const f = page({
      inputs: [
        [1, { type: "text", name: "q" }],
        [2, { type: "text", name: "otp" }],
        [3, { type: "password", disabled: "" }],
        [4, { type: "email", readonly: "" }],
      ],
    });
    expect((await f.reader.read({}, { fields: true }, f.signal))?.field).toBeUndefined();
  });

  it("says nothing of what a filled field holds", async () => {
    const f = page({ inputs: [[1, { type: "password" }]], hold: "filled-canary" });
    expect(JSON.stringify(await f.reader.read({}, { fields: true }, f.signal))).not.toContain(
      "filled-canary",
    );
  });

  it("answers null with no page in front, and ends its lease either way", async () => {
    const f = page({ url: null });
    expect(await f.reader.read({}, { fields: true }, f.signal)).toBeNull();
    expect(f.finish).toHaveBeenCalledOnce();
  });
});
