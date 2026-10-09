import { DEFAULT_AUTONOMY, type ElementsRequest, type WireElement } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { toolHarness } from "../testing/harness.ts";

const element = (over: Partial<WireElement>): WireElement => ({
  point: { x: 200, y: 100 },
  bbox: { x: 100, y: 80, w: 200, h: 40 },
  source: "dom",
  role: "button",
  name: "Save",
  app: "Chromium",
  window: "Notes - Chromium",
  ...over,
});

let close: (() => void) | undefined;
afterEach(() => close?.());

// The harness's desktop at scale 2, with desktopd's element lookups answered by `answer`.
function harness(answer: (request: ElementsRequest) => Promise<unknown>, maxToolCalls?: number) {
  const h = toolHarness({ autonomy: DEFAULT_AUTONOMY, ...(maxToolCalls ? { maxToolCalls } : {}) });
  close = h.close;
  const requests: ElementsRequest[] = [];
  const desktop = h.tools.desktop.bind(h.tools);
  h.tools.desktop = (cellId) => {
    const tools = desktop(cellId);
    return (
      tools && {
        ...tools,
        elements: async (request: ElementsRequest) => {
          requests.push(request);
          return (await answer(request)) as never;
        },
      }
    );
  };
  return { ...h, requests };
}

const textOf = (body: { content: { type: string; text?: string }[] }) =>
  body.content.map((c) => c.text ?? "").join("\n");

describe("find", () => {
  it("lists the desktop's controls by name with the point to click, in model pixels", async () => {
    const h = harness(async () => ({
      elements: [
        element({ source: "ax", role: "push button", name: "Replace All", window: "Find" }),
        element({ source: "ax", role: "check box", name: "Replace all in:", bbox: undefined }),
      ],
      truncated: true,
    }));
    const { body } = await h.call("find", { text: "Replace", role: "push button" });
    expect(body.ok).toBe(true);
    expect(h.requests).toEqual([{ text: "Replace", role: "push button", limit: 20 }]);
    const text = textOf(body);
    expect(text).toContain('<untrusted source="the desktop');
    expect(text).toContain('- push button "Replace All" in "Find" at (100, 50) [50, 40, 150, 60]');
    expect(text).not.toContain("Replace all in:");
    expect(text).toContain("more matched");
  });

  it("says plainly when nothing has that name", async () => {
    const h = harness(async () => ({ elements: [], truncated: false }));
    const { body } = await h.call("find", { text: "Frobnicate" });
    expect(textOf(body)).toContain('No control on the desktop has a name containing "Frobnicate"');
  });
});

describe("browser_read", () => {
  it("lists the page's elements by ref and keeps them for browser_act", async () => {
    const h = harness(async () => ({
      url: "https://example.com/",
      elements: [
        element({ node: 12, role: "textbox", name: "Email", state: { value: "a@b.c" } }),
        element({ node: 13, role: "checkbox", name: "Remember me", state: { checked: "false" } }),
        element({ node: 14, role: "textbox", name: "Password", secret: true }),
      ],
      truncated: false,
    }));
    const { body } = await h.call("browser_read", {});
    const text = textOf(body);
    expect(text).toContain('e12 textbox "Email" value "a@b.c" [50, 40, 150, 60]');
    expect(text).toContain('e13 checkbox "Remember me" unchecked [50, 40, 150, 60]');
    expect(text).toContain('e14 textbox "Password" password [50, 40, 150, 60]');
    expect(h.requests).toEqual([{ page: true, limit: 150 }]);
    expect([...(h.session.pageRefs?.elements.keys() ?? [])]).toEqual(["e12", "e13", "e14"]);
    expect(h.session.pageRefs?.cellId).toBe(h.session.cellId);
  });

  it("lists no elements of a page other than the one it read", async () => {
    const h = harness(async () => ({
      url: "https://elsewhere.example/",
      elements: [element({ node: 12 })],
      truncated: false,
    }));
    const { body } = await h.call("browser_read", {});
    expect(textOf(body)).not.toContain("e12");
    expect(h.session.pageRefs?.elements.size).toBe(0);
  });
});

describe("the user's action limit", () => {
  it("counts every step of a batch", async () => {
    const h = harness(async () => ({ elements: [], truncated: false }), 2);
    const { body } = await h.call("computer", {
      action: "batch",
      steps: [
        { action: "key", keys: ["Tab"] },
        { action: "key", keys: ["Tab"] },
        { action: "key", keys: ["Return"] },
      ],
    });
    expect(body).toMatchObject({ ok: false, final: true });
    expect(textOf(body)).toContain("limit of 2 actions");
    expect(h.actions).toHaveLength(0);
  });
});
