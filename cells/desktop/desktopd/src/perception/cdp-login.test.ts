import { REACT_FORM_ACTION } from "@localdot/protocol";
import { expect, it } from "vitest";
import { fakeCdp, fakeTargets } from "../testing/fake-cdp.ts";
import { ChromiumPerception } from "./cdp.ts";
import type { HelperWindow } from "./hit-test.ts";

const win: HelperWindow = {
  id: 1,
  pid: 1,
  cls: "Chromium",
  title: "Login - Chromium",
  x: 0,
  y: 0,
  w: 1280,
  h: 800,
  frame: [0, 0, 1280, 800],
  active: true,
  overrideRedirect: false,
  transientFor: null,
};
it.each([
  ["https://login.example.test/", REACT_FORM_ACTION, "current-password", true],
  ["https://elsewhere.test/", REACT_FORM_ACTION, "current-password", false],
  ["https://login.example.test/", "https://elsewhere.test/steal", "current-password", false],
  ["https://login.example.test/", REACT_FORM_ACTION, "new-password", false],
])(
  "binds desktop saved access only to a verified HTTPS password form (%s, %s, %s)",
  async (actual, action, autocomplete, accepted) => {
    const origin = "https://login.example.test";
    const strings = [
      "#document",
      "FORM",
      "INPUT",
      "BUTTON",
      "action",
      action,
      "type",
      "password",
      "autocomplete",
      autocomplete,
      actual,
    ];
    const snapshot = {
      strings,
      documents: [
        {
          documentURL: 10,
          nodes: {
            nodeName: [0, 1, 2, 3],
            backendNodeId: [1, 2, 3, 4],
            parentIndex: [-1, 0, 1, 1],
            attributes: [[], [4, 5], [6, 7, 8, 9], []],
          },
        },
      ],
    };
    const peer = fakeCdp((method) => {
      switch (method) {
        case "Accessibility.enable":
          return {};
        case "Runtime.evaluate":
          return {
            result: {
              value: {
                dpr: 1,
                chromeW: 0,
                chromeH: 0,
                innerWidth: 1280,
                innerHeight: 800,
                url: origin + "/",
              },
            },
          };
        case "DOM.getDocument":
          return { root: { nodeId: 1 } };
        case "DOM.getNodeForLocation":
          return { backendNodeId: 3 };
        case "DOM.getBoxModel":
          return { model: { border: [10, 10, 100, 10, 100, 40, 10, 40] } };
        case "Accessibility.getPartialAXTree":
          return { nodes: [{ role: { value: "textbox" }, name: { value: "Password" } }] };
        case "DOM.describeNode":
          return { node: { attributes: ["type", "password", "autocomplete", autocomplete] } };
        case "DOMSnapshot.captureSnapshot":
          return snapshot;
        case "Accessibility.getFullAXTree":
          return { nodes: [{ backendDOMNodeId: 4, name: { value: "Sign in" } }] };
        default:
          throw new Error("unexpected CDP request");
      }
    });
    const cdp = new ChromiumPerception({
      WebSocketImpl: peer.WebSocketImpl,
      fetchImpl: fakeTargets([{ type: "page", url: origin, title: "Login" }]),
    });
    try {
      const target = await cdp.hitTest(win, { x: 20, y: 20 });
      expect(target?.secret).toBe(true);
      expect(target?.loginOrigin).toBe(accepted ? origin : undefined);
    } finally {
      await cdp.close();
    }
  },
);
