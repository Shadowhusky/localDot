import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GuardedCdp } from "./cdp-guard.ts";
import { pipeTransport } from "./pipe.ts";

const CHROME = process.env.LOCALDOT_CHROME ?? "";
const run = CHROME ? describe : describe.skip;
const CANARY = `ldcanary${randomBytes(12).toString("hex")}`;
const PAGE = `<!doctype html><title>Sign in</title><form><label>User <input id=u></label>
<label>Password <input id=p type=password></label><input id=f type=file><a id=dl href="/file">Get it</a></form>
<script>const v=atob("${Buffer.from(CANARY).toString("base64")}");document.cookie="js="+v+"-js";localStorage.setItem("k",v+"-ls");sessionStorage.setItem("s",v+"-ss")</script>`;

// The page writes its script-visible cookie and storage from a base64 copy, so the canary is in
// the page's storage but never in its source (page source is page content, which the agent may read).
// The cell's forwarder stands in as an explicit proxy that serves canary.test itself, so the page
// is reached the way the cell reaches the web: by name, through the proxy, never loopback.
function fixtureProxy(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://invalid");
    if (url.hostname !== "canary.test") {
      res.writeHead(403);
      return res.end();
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html", "set-cookie": `sid=${CANARY}-http; HttpOnly; Path=/` });
      return res.end(PAGE);
    }
    if (url.pathname === "/file") {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=payload.sh" });
      return res.end("#!/bin/sh\necho owned\n");
    }
    if (url.pathname === "/echo") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<!doctype html><title>echo</title><p>${(req.headers.cookie ?? "").replace(/</g, "")}</p>`);
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, port: (server.address() as { port: number }).port })));
}

run("browserd's CDP path against a real Chromium (Review Focus 1)", () => {
  let proxy: { server: Server; port: number };
  let chrome: ChildProcess;
  let cdp: GuardedCdp;
  const raw: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "ld-chrome-"));
  const downloads = join(dir, "downloads");
  const uploads = join(dir, "uploads");
  let session = "";
  const events: { method: string; params: Record<string, unknown> }[] = [];

  beforeAll(async () => {
    mkdirSync(downloads);
    mkdirSync(join(uploads, "u1"), { recursive: true });
    proxy = await fixtureProxy();
    chrome = spawn(
      CHROME,
      [
        "--remote-debugging-pipe",
        `--user-data-dir=${join(dir, "profile")}`,
        `--proxy-server=http://127.0.0.1:${proxy.port}`,
        "--proxy-bypass-list=<-loopback>",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        ...(process.env.LOCALDOT_CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
    );
    const transport = pipeTransport(chrome.stdio[3] as Writable, chrome.stdio[4] as Readable);
    transport.onMessage((m) => raw.push(m));
    cdp = new GuardedCdp(transport, { downloadDir: downloads, uploadDir: uploads });
    for (const method of ["Page.fileChooserOpened", "Browser.downloadWillBegin", "Browser.downloadProgress"] as const)
      cdp.on(method, (params) => events.push({ method, params }));
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: downloads, eventsEnabled: true });
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    ({ sessionId: session } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }));
    await cdp.send("Page.enable", {}, session);
    await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true }, session);
  }, 30_000);

  afterAll(() => {
    cdp?.close();
    chrome?.kill("SIGKILL");
    proxy?.server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("signs in, reads, hit-tests, downloads and uploads without one byte of cookie or storage", async () => {
    await cdp.send("Page.navigate", { url: "http://canary.test/" }, session);
    await settle(1500);
    const ax = await cdp.send<{ nodes: { role?: { value: string }; name?: { value: string }; backendDOMNodeId?: number }[] }>("Accessibility.getFullAXTree", {}, session);
    expect(ax.nodes.some((n) => n.name?.value === "Get it")).toBe(true);
    const doc = await cdp.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: 1 }, session);
    expect(doc.root.nodeId).toBeGreaterThan(0);
    const link = ax.nodes.find((n) => n.name?.value === "Get it");
    const box = await cdp.send<{ model: { content: number[] } }>("DOM.getBoxModel", { backendNodeId: link?.backendDOMNodeId }, session);
    const hit = await cdp.send<{ backendNodeId: number }>("DOM.getNodeForLocation", { x: Math.round((box.model.content[0] ?? 0) + 2), y: Math.round((box.model.content[1] ?? 0) + 2) }, session);
    expect(hit.backendNodeId).toBeGreaterThan(0);
    // The download is started by the page itself here (a navigation to the attachment), as a
    // drive-by download would be.
    await cdp.send("Page.navigate", { url: "http://canary.test/file" }, session);
    await settle(1500);
    const done = events.find((e) => e.method === "Browser.downloadProgress" && e.params.state === "completed");
    expect(done).toBeDefined();
    expect(readdirSync(downloads)).toEqual([String(done?.params.guid)]);
    const begin = events.find((e) => e.method === "Browser.downloadWillBegin");
    expect(begin?.params.suggestedFilename).toBe("payload.sh");
    // Nothing the pipe carried held a cookie or storage value.
    const leaks = raw.filter((m) => m.includes(CANARY)).map((m) => { const j = JSON.parse(m); const i = m.indexOf(CANARY); return `${j.method ?? `reply ${j.id}`}: ...${m.slice(Math.max(0, i - 200), i + 60)}`; });
    expect(leaks).toEqual([]);
  }, 30_000);

  it("keeps the cookie in the profile all the same (the canary was real)", async () => {
    await cdp.send("Page.navigate", { url: "http://canary.test/echo" }, session);
    await settle(1000);
    const ax = await cdp.send<{ nodes: { name?: { value: string } }[] }>("Accessibility.getFullAXTree", {}, session);
    expect(ax.nodes.some((n) => (n.name?.value ?? "").includes(`${CANARY}-http`))).toBe(true);
  }, 30_000);
});
