import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { ChromiumPerception, contentOrigin, pickTarget, quadToRect } from "./cdp.ts";
import type { HelperWindow } from "./hit-test.ts";

const win: HelperWindow = {
  id: 9,
  pid: 90,
  cls: "Chromium",
  title: "S2 marker - Chromium",
  x: 0,
  y: 54,
  w: 2560,
  h: 1546,
  frame: [0, 54, 2560, 1546],
  active: true,
  overrideRedirect: false,
  transientFor: null,
};

describe("pure CDP geometry", () => {
  it("places the content area below Chromium's own chrome, centred horizontally", () => {
    expect(contentOrigin(win, { dpr: 2, chromeW: 0, chromeH: 87 })).toEqual({ x: 0, y: 54 + 174 });
    expect(
      contentOrigin({ ...win, x: 20, y: 74, w: 2100 }, { dpr: 2, chromeW: 16, chromeH: 87 }),
    ).toEqual({ x: 36, y: 248 });
  });

  it("turns a border quad in CSS px into a device-pixel rect", () => {
    expect(quadToRect([40, 100, 160, 100, 160, 140, 40, 140], { x: 0, y: 228 }, 2)).toEqual({
      x: 80,
      y: 428,
      w: 240,
      h: 80,
    });
  });

  it("picks the page target whose title matches the window title", () => {
    const targets = [
      { id: "a", type: "page", title: "Other", url: "x", webSocketDebuggerUrl: "ws://a" },
      { id: "b", type: "page", title: "S2 marker", url: "y", webSocketDebuggerUrl: "ws://b" },
    ] as const;
    expect(pickTarget([...targets], win)?.id).toBe("b");
    expect(pickTarget([...targets], { ...win, title: "Nothing - Chromium" })).toBeUndefined();
    expect(pickTarget(targets.slice(0, 1), { ...win, title: "Nothing - Chromium" })?.id).toBe("a");
    expect(pickTarget([...targets, { ...targets[1], id: "duplicate" }], win)).toBeUndefined();
  });
});

describe("ChromiumPerception against a scripted DevTools endpoint", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
  });

  async function scriptedChromium(
    answers: Record<string, (params: Record<string, unknown>) => unknown>,
  ) {
    const http = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify([
          {
            id: "p1",
            type: "page",
            title: "S2 marker",
            url: "file:///opt/localdot/marker.html",
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/p1`,
          },
        ]),
      );
    });
    const port = await new Promise<number>((r) =>
      http.listen(0, "127.0.0.1", () => r((http.address() as { port: number }).port)),
    );
    const wss = new WebSocketServer({ server: http });
    const seen: string[] = [];
    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(String(data)) as {
          id: number;
          method: string;
          params: Record<string, unknown>;
        };
        seen.push(msg.method);
        const fn = answers[msg.method];
        ws.send(
          JSON.stringify(
            fn
              ? { id: msg.id, result: fn(msg.params) }
              : { id: msg.id, error: { message: `no ${msg.method}` } },
          ),
        );
      });
    });
    close = () => new Promise<void>((r) => http.close(() => r()));
    // The page's side ends every DevTools socket, as a navigation or a crash does.
    const drop = () => {
      for (const client of wss.clients) client.terminate();
    };
    return { port, seen, drop };
  }

  it("hit-tests a web element: box, role, name, url, and the password flag", async () => {
    const { port, seen } = await scriptedChromium({
      "Accessibility.enable": () => ({}),
      "Runtime.evaluate": () => ({
        result: {
          value: {
            dpr: 2,
            chromeW: 0,
            chromeH: 87,
            innerWidth: 1280,
            innerHeight: 686,
            url: "file:///opt/localdot/marker.html",
          },
        },
      }),
      "DOM.getDocument": () => ({ root: { nodeId: 1 } }),
      "DOM.getNodeForLocation": (p) => ({
        backendNodeId: 42,
        frameId: "f",
        nodeId: 7,
        ...(p.x === 100 ? {} : {}),
      }),
      "DOM.getBoxModel": () => ({ model: { border: [40, 100, 160, 100, 160, 140, 40, 140] } }),
      "Accessibility.getPartialAXTree": () => ({
        nodes: [{ role: { value: "textbox" }, name: { value: "Password" } }],
      }),
      "DOM.describeNode": () => ({ node: { attributes: ["type", "password", "name", "pw"] } }),
    });
    const cdp = new ChromiumPerception({ port });
    const target = await cdp.hitTest(win, { x: 200, y: 450 });
    expect(target).toMatchObject({
      point: { x: 200, y: 450 },
      source: "dom",
      role: "textbox",
      name: "Password",
      bbox: { x: 80, y: 428, w: 240, h: 80 },
      url: "file:///opt/localdot/marker.html",
      secret: true,
      app: "Chromium",
    });
    expect(seen).toContain("DOM.getNodeForLocation");
    expect(await cdp.hitTest(win, { x: 200, y: 100 })).toBeNull();
    expect(seen.filter((m) => m === "Accessibility.enable")).toHaveLength(1);
    await cdp.close();
  });

  it("finds by accessible name through Accessibility.queryAXTree", async () => {
    const { port } = await scriptedChromium({
      "Accessibility.enable": () => ({}),
      "Runtime.evaluate": () => ({
        result: {
          value: { dpr: 2, chromeW: 0, chromeH: 87, innerWidth: 1280, innerHeight: 686, url: "u" },
        },
      }),
      "DOM.getDocument": () => ({ root: { nodeId: 1 } }),
      "Accessibility.queryAXTree": (p) => ({
        nodes:
          p.accessibleName === "marker green"
            ? [{ backendDOMNodeId: 5, role: { value: "button" }, name: { value: "marker green" } }]
            : [],
      }),
      "DOM.getBoxModel": () => ({ model: { border: [300, 100, 420, 100, 420, 140, 300, 140] } }),
      "DOM.describeNode": () => ({ node: { attributes: [] } }),
    });
    const cdp = new ChromiumPerception({ port });
    const found = await cdp.find(win, { name: "marker green", role: "button" });
    expect(found).toMatchObject({
      role: "button",
      name: "marker green",
      bbox: { x: 600, y: 428, w: 240, h: 80 },
      point: { x: 720, y: 468 },
    });
    expect(await cdp.find(win, { name: "nothing" })).toBeNull();
    await cdp.close();
  });

  const metrics = () => ({
    result: {
      value: {
        dpr: 2,
        chromeW: 0,
        chromeH: 87,
        innerWidth: 1280,
        innerHeight: 686,
        url: "file:///opt/localdot/marker.html",
      },
    },
  });
  // A CSS-pixel quad at (x, y), w × h.
  const quad = (x: number, y: number, w = 100, h = 40) => ({
    model: { border: [x, y, x + w, y, x + w, y + h, x, y + h] },
  });

  it("lists the interactive elements in view in reading order, with their state and nodes", async () => {
    const boxes: Record<number, ReturnType<typeof quad>> = {
      1: quad(40, 300),
      2: quad(40, 100, 300),
      3: quad(40, 900),
      4: quad(400, 100),
      5: quad(40, 200),
    };
    const { port } = await scriptedChromium({
      "Accessibility.enable": () => ({}),
      "Runtime.evaluate": metrics,
      "Accessibility.getFullAXTree": () => ({
        nodes: [
          { backendDOMNodeId: 1, role: { value: "button" }, name: { value: "Send" } },
          {
            backendDOMNodeId: 2,
            role: { value: "textbox" },
            name: { value: "Email" },
            value: { value: "robin@example.com" },
          },
          { backendDOMNodeId: 3, role: { value: "link" }, name: { value: "Below the fold" } },
          {
            backendDOMNodeId: 4,
            role: { value: "textbox" },
            name: { value: "Password" },
            value: { value: "secret" },
          },
          {
            backendDOMNodeId: 5,
            role: { value: "checkbox" },
            name: { value: "Remember me" },
            properties: [{ name: "checked", value: { value: "true" } }],
          },
          { backendDOMNodeId: 6, role: { value: "StaticText" }, name: { value: "Hello" } },
          { backendDOMNodeId: 7, ignored: true, role: { value: "button" } },
        ],
      }),
      "DOM.getBoxModel": (p) => boxes[p.backendNodeId as number],
      "DOM.describeNode": (p) => ({
        node: { attributes: p.backendNodeId === 4 ? ["type", "password"] : ["type", "text"] },
      }),
    });
    const cdp = new ChromiumPerception({ port, originProvider: async () => ({ x: 0, y: 228 }) });
    const page = await cdp.elements(win, 10);
    expect(page.url).toBe("file:///opt/localdot/marker.html");
    expect(page.origin).toEqual({ x: 0, y: 228 });
    expect(page.elements.map((e) => [e.node, e.role, e.name, e.state, e.secret])).toEqual([
      [2, "textbox", "Email", { value: "robin@example.com" }, undefined],
      [4, "textbox", "Password", undefined, true],
      [5, "checkbox", "Remember me", { checked: "true" }, undefined],
      [1, "button", "Send", undefined, undefined],
    ]);
    expect(page.elements[0]?.bbox).toEqual({ x: 80, y: 428, w: 600, h: 80 });
    expect((await cdp.elements(win, 2)).truncated).toBe(true);
    await cdp.close();
  });

  it("lists what is in view on a long page scrolled down, past its first 400 elements", async () => {
    const above = 450;
    const { port } = await scriptedChromium({
      "Accessibility.enable": () => ({}),
      "Runtime.evaluate": metrics,
      "Accessibility.getFullAXTree": () => ({
        nodes: Array.from({ length: above + 3 }, (_, i) => ({
          backendDOMNodeId: i + 1,
          role: { value: "link" },
          name: { value: `Link ${i + 1}` },
        })),
      }),
      "DOM.getBoxModel": (p) => {
        const node = p.backendNodeId as number;
        return node > above ? quad(40, 100 + (node - above) * 50) : quad(40, -5000 + node);
      },
      "DOM.describeNode": () => ({ node: { attributes: [] } }),
    });
    const cdp = new ChromiumPerception({ port, originProvider: async () => ({ x: 0, y: 228 }) });
    const page = await cdp.elements(win, 10);
    expect(page.elements.map((e) => e.name)).toEqual(["Link 451", "Link 452", "Link 453"]);
    expect(page.truncated).toBe(false);
    await cdp.close();
  });

  it("finds an element by its node only while some of it is in view, cut to the view", async () => {
    const boxes: Record<number, ReturnType<typeof quad>> = { 1: quad(40, 660), 2: quad(40, 700) };
    const { port } = await scriptedChromium({
      "Accessibility.enable": () => ({}),
      "Runtime.evaluate": metrics,
      "Accessibility.getPartialAXTree": (p) => ({
        nodes: [
          {
            backendDOMNodeId: p.backendNodeId,
            role: { value: "button" },
            name: { value: "Go" },
            properties: [{ name: "checked", value: { value: "false" } }],
          },
        ],
      }),
      "DOM.getBoxModel": (p) => boxes[p.backendNodeId as number],
      "DOM.describeNode": () => ({ node: { attributes: [] } }),
    });
    const origins: number[] = [];
    const cdp = new ChromiumPerception({
      port,
      originProvider: async (_w, dpr) => {
        origins.push(dpr);
        return { x: 0, y: 228 };
      },
    });
    // 26 of its 40 CSS px are above the bottom of the 686 px view.
    expect(await cdp.node(win, 1)).toMatchObject({
      role: "button",
      name: "Go",
      bbox: { x: 80, y: 1548, w: 200, h: 52 },
      point: { x: 180, y: 1574 },
      checked: "false",
    });
    expect(await cdp.node(win, 2)).toBeNull();
    expect(origins[0]).toBe(2);
    await cdp.close();
  });

  it("opens a new session once the page's socket has closed", async () => {
    const { port, seen, drop } = await scriptedChromium({
      "Accessibility.enable": () => ({}),
      "Runtime.evaluate": () => ({
        result: { value: { dpr: 2, chromeW: 0, chromeH: 87, innerWidth: 1280, innerHeight: 686 } },
      }),
    });
    const cdp = new ChromiumPerception({ port });
    expect(await cdp.deviceScaleFactor(win)).toBe(2);
    drop();
    await new Promise((r) => setTimeout(r, 20));
    expect(await cdp.deviceScaleFactor(win)).toBe(2);
    expect(seen.filter((m) => m === "Accessibility.enable")).toHaveLength(2);
    await cdp.close();
  });
});
