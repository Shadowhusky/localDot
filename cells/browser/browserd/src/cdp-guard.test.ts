import { describe, expect, it } from "vitest";
import { type CdpCapabilities, guardCdpCommand, navigable } from "./cdp-guard.ts";

const download = "e219565a-fcaf-45cc-a763-2d2e7dc33fa7";
const capabilities: CdpCapabilities = {
  downloadDir: "/tmp/localdot-downloads",
  uploadDir: "/tmp/localdot-uploads",
  ownsTarget: (target) => target === "page-1",
  ownsSession: (session) => session === "session-1",
  ownsWindow: (window) => window === 1,
  ownsNode: (session, node) => session === "session-1" && node === 4,
  ownsDownload: (guid) => guid === download,
  allowsUpload: (session, node, files) =>
    session === "session-1" &&
    node === 4 &&
    files.length === 1 &&
    files[0] === "/tmp/localdot-uploads/approved",
};
const targetFilter = [
  { type: "page", exclude: false },
  { type: "iframe", exclude: false },
  { exclude: true },
];
const roots: [string, Record<string, unknown>][] = [
  ["Browser.getVersion", {}],
  [
    "Browser.setDownloadBehavior",
    { behavior: "allowAndName", downloadPath: capabilities.downloadDir, eventsEnabled: true },
  ],
  ["Browser.cancelDownload", { guid: download }],
  ["Browser.getWindowForTarget", { targetId: "page-1" }],
  ["Browser.setWindowBounds", { windowId: 1, bounds: { windowState: "maximized" } }],
  ["Target.setDiscoverTargets", { discover: true, filter: targetFilter }],
  [
    "Target.setAutoAttach",
    { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: targetFilter },
  ],
  ["Target.getTargets", { filter: targetFilter }],
  ["Target.attachToTarget", { targetId: "page-1", flatten: true }],
  ["Target.detachFromTarget", { sessionId: "session-1" }],
  ["Target.createTarget", { url: "about:blank" }],
  ["Target.activateTarget", { targetId: "page-1" }],
  ["Target.closeTarget", { targetId: "page-1" }],
];
const pages: [string, Record<string, unknown>][] = [
  ["Runtime.runIfWaitingForDebugger", {}],
  ["Page.enable", {}],
  ["Page.navigate", { url: "https://example.com/" }],
  ["Page.reload", {}],
  ["Page.stopLoading", {}],
  ["Page.getLayoutMetrics", {}],
  ["Page.getFrameTree", {}],
  ["Page.bringToFront", {}],
  ["Page.setInterceptFileChooserDialog", { enabled: true }],
  ["Page.handleJavaScriptDialog", { accept: false }],
  [
    "Emulation.setDeviceMetricsOverride",
    { width: 1280, height: 712, deviceScaleFactor: 0, mobile: false },
  ],
  ["Emulation.clearDeviceMetricsOverride", {}],
  ["DOM.enable", {}],
  ["DOM.getDocument", { depth: 1 }],
  ["DOM.getNodeForLocation", { x: 10, y: 20 }],
  ["DOM.getBoxModel", { backendNodeId: 4 }],
  ["DOM.describeNode", { backendNodeId: 4 }],
  ["DOM.setFileInputFiles", { backendNodeId: 4, files: ["/tmp/localdot-uploads/approved"] }],
  ["Accessibility.enable", {}],
  ["Accessibility.getFullAXTree", {}],
  ["Accessibility.getPartialAXTree", { backendNodeId: 4, fetchRelatives: false }],
];

describe("closed private CDP command boundary", () => {
  it("allows bounded document coordinates beyond the screen only in an owned session", () => {
    expect(
      guardCdpCommand("DOM.getNodeForLocation", { x: 170, y: 12030 }, capabilities, "session-1")
        .params,
    ).toEqual({ x: 170, y: 12030 });
    for (const documentY of [-1, 0x80000000, 1.5, Infinity, NaN])
      expect(() =>
        guardCdpCommand(
          "DOM.getNodeForLocation",
          { x: 170, y: documentY },
          capabilities,
          "session-1",
        ),
      ).toThrow("params");
    expect(() =>
      guardCdpCommand("DOM.getNodeForLocation", { x: 170, y: 12030 }, capabilities, "foreign"),
    ).toThrow("scope");
  });

  it.each(roots)(
    "accepts the narrow root command %s and rejects extra capabilities",
    (method, params) => {
      expect(guardCdpCommand(method, params, capabilities)).toEqual({ method, params });
      expect(() =>
        guardCdpCommand(method, { ...params, expression: "secret" }, capabilities),
      ).toThrow("params");
      if (method === "Target.setAutoAttach")
        expect(() => guardCdpCommand(method, params, capabilities, "session-1")).not.toThrow();
      else
        expect(() => guardCdpCommand(method, params, capabilities, "session-1")).toThrow("scope");
    },
  );

  it.each(pages)(
    "accepts the narrow page command %s only in its owned session",
    (method, params) => {
      expect(guardCdpCommand(method, params, capabilities, "session-1")).toEqual({
        method,
        params,
        sessionId: "session-1",
      });
      expect(() => guardCdpCommand(method, params, capabilities)).toThrow("scope");
      expect(() => guardCdpCommand(method, params, capabilities, "foreign")).toThrow("scope");
      expect(() =>
        guardCdpCommand(
          method,
          { ...params, objectId: "cookie-object" },
          capabilities,
          "session-1",
        ),
      ).toThrow("params");
    },
  );

  it.each([
    "Runtime.evaluate",
    "Runtime.callFunctionOn",
    "Runtime.getProperties",
    "Network.getCookies",
    "Network.getAllCookies",
    "Storage.setCookies",
    "Storage.clearCookies",
    "DOMStorage.getDOMStorageItems",
    "IndexedDB.requestData",
    "CacheStorage.requestEntries",
    "Fetch.enable",
    "Network.setRequestInterception",
    "Page.addScriptToEvaluateOnNewDocument",
    "Page.captureScreenshot",
    "Input.dispatchKeyEvent",
    "Browser.executeBrowserCommand",
    "Target.createBrowserContext",
    "DOM.getOuterHTML",
    "DOMDebugger.getEventListeners",
    "__proto__",
    "constructor",
  ])("refuses %s before anything can be sent to Chromium", (method) => {
    expect(() => guardCdpCommand(method, {}, capabilities, "session-1")).toThrow("method");
  });

  it("forbids script injection and navigation of unowned targets", () => {
    expect(() =>
      guardCdpCommand(
        "Page.reload",
        { scriptToEvaluateOnLoad: "document.cookie" },
        capabilities,
        "session-1",
      ),
    ).toThrow("params");
    expect(() =>
      guardCdpCommand(
        "Target.attachToTarget",
        { targetId: "devtools", flatten: true },
        capabilities,
      ),
    ).toThrow("scope");
    expect(() =>
      guardCdpCommand("Target.createTarget", { url: "chrome://settings" }, capabilities),
    ).toThrow("params");
    expect(() =>
      guardCdpCommand("Target.closeTarget", { targetId: "devtools" }, capabilities),
    ).toThrow("scope");
    for (const metrics of [
      { width: 375, height: 667, deviceScaleFactor: 3, mobile: true },
      { width: 1280, height: 712, deviceScaleFactor: 0, mobile: false, screenWidth: 375 },
      { width: 0, height: 712, deviceScaleFactor: 0, mobile: false },
    ])
      expect(() =>
        guardCdpCommand("Emulation.setDeviceMetricsOverride", metrics, capabilities, "session-1"),
      ).toThrow("params");
    expect(() =>
      guardCdpCommand("DOM.describeNode", { backendNodeId: 5 }, capabilities, "session-1"),
    ).toThrow("scope");
  });

  it("fixes quarantine destination and requires an owned cancellation identity", () => {
    expect(() =>
      guardCdpCommand(
        "Browser.setDownloadBehavior",
        {
          behavior: "allowAndName",
          downloadPath: "/home/desktop",
          eventsEnabled: true,
        },
        capabilities,
      ),
    ).toThrow("download");
    expect(() =>
      guardCdpCommand(
        "Browser.setDownloadBehavior",
        {
          behavior: "allow",
          downloadPath: capabilities.downloadDir,
          eventsEnabled: true,
        },
        capabilities,
      ),
    ).toThrow("params");
    expect(() =>
      guardCdpCommand(
        "Browser.cancelDownload",
        {
          guid: "05638474-4f14-4f6c-ac0e-b5043f308a3a",
        },
        capabilities,
      ),
    ).toThrow("download");
  });

  it.each([
    ["/profile/Cookies"],
    ["/tmp/localdot-uploads/../profile/Cookies"],
    ["/tmp/localdot-uploads/not-approved"],
    ["/tmp/localdot-uploads/approved", "/tmp/localdot-uploads/approved"],
    ["/tmp/localdot-uploads/folder/approved"],
    ["/tmp/localdot-uploads/approved\u0000"],
    [],
  ])("refuses unstaged or malformed file-upload paths %#", (...files) => {
    expect(() =>
      guardCdpCommand(
        "DOM.setFileInputFiles",
        { backendNodeId: 4, files },
        capabilities,
        "session-1",
      ),
    ).toThrow();
  });

  it("snapshots and freezes nested parameters before the transport writes them", () => {
    const params = { backendNodeId: 4, files: ["/tmp/localdot-uploads/approved"] };
    const command = guardCdpCommand("DOM.setFileInputFiles", params, capabilities, "session-1");
    params.files[0] = "/profile/Cookies";
    expect(command.params.files).toEqual(["/tmp/localdot-uploads/approved"]);
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.params)).toBe(true);
    expect(Object.isFrozen(command.params.files)).toBe(true);
  });
});

describe("web-only navigation syntax before keyd resolution", () => {
  it.each([
    "https://example.com/",
    "http://example.com:80/path",
    "https://example.com:443/a?q=1",
    "https://例子.测试/",
    "https://example.com./",
  ])("permits public hostname syntax %s", (url) => expect(navigable(url)).toBe(true));
  it.each([
    "javascript:alert(1)",
    "data:text/html,secret",
    "file:///profile/Cookies",
    "chrome://settings",
    "view-source:https://example.com",
    "devtools://devtools",
    "ws://example.com",
    "https://example.com:8443/",
    "http://127.1",
    "http://2130706433",
    "http://0x7f000001",
    "http://[::1]",
    "http://localhost",
    "http://localhost.",
    "http://sub.localhost",
    "https://name:password@example.com",
    " https://example.com",
    "https://example.com/\nsecret",
    "https://example..com",
    "https://.example.com",
    "https://-example.com",
  ])("refuses %s", (url) => {
    expect(navigable(url)).toBe(false);
    expect(() => guardCdpCommand("Page.navigate", { url }, capabilities, "session-1")).toThrow(
      "url",
    );
  });
});
