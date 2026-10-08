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
