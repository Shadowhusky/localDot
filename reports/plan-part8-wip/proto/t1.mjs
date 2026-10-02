import { launch, serve, wait } from "./cdp.mjs";
import { readdirSync, readFileSync } from "node:fs";
const page = `<!doctype html><title>Login</title><form><label>User <input id=u name=u></label>
<label>Password <input id=p type=password autocomplete=current-password></label>
<label>Code <input id=c autocomplete=one-time-code></label>
<input id=f type=file><a href="/dl">Get file</a><button id=b>Sign in</button></form>
<script>document.cookie="vis=JSCANARY";localStorage.setItem("k","LSCANARY")</script>`;
const { server, port } = await serve({
  "/": { body: page, headers: { "content-type": "text/html", "set-cookie": "sid=HTTPONLYCANARY; HttpOnly; Path=/" } },
  "/dl": { body: "\x7fELF fake", headers: { "content-type": "application/octet-stream", "content-disposition": "attachment; filename*=UTF-8''invoice%E2%80%AEfdp.exe" } },
});
const c = launch({ extra: process.argv.slice(2) });
const events = [];
c.on((m) => events.push(m));
await wait(1500);
const { targetId } = await c.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
const s = (m, p) => c.send(m, p, sessionId);
await s("Page.enable");
await s("Page.setInterceptFileChooserDialog", { enabled: true });
await c.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: "/tmp/job-plan-part8/dl", eventsEnabled: true });
await s("Page.navigate", { url: `http://127.0.0.1:${port}/` });
await wait(1500);
// type into the password field
const doc = await s("DOM.getDocument", { depth: -1 });
const q = async (sel) => (await s("DOM.querySelector", { nodeId: doc.root.nodeId, selector: sel })).nodeId;
await s("DOM.focus", { nodeId: await q("#p") });
for (const ch of "hunter2") await s("Input.dispatchKeyEvent", { type: "keyDown", text: ch });
await s("DOM.focus", { nodeId: await q("#u") });
for (const ch of "alice") await s("Input.dispatchKeyEvent", { type: "keyDown", text: ch });
const ax = await s("Accessibility.getFullAXTree");
for (const n of ax.nodes) if (n.role?.value === "textbox") console.log("AX textbox", JSON.stringify({ name: n.name?.value, value: n.value?.value, props: n.properties?.map((p) => p.name) , be: n.backendDOMNodeId }));
const pw = ax.nodes.find((n) => n.role?.value === "textbox" && n.name?.value?.startsWith("Password"));
if (pw) console.log("describe", JSON.stringify((await s("DOM.describeNode", { backendNodeId: pw.backendDOMNodeId })).node.attributes));
// focused node
console.log("focused", ax.nodes.filter((n) => n.properties?.some((p) => p.name === "focused" && p.value.value)).map((n) => n.name?.value));
// file chooser: click the file input
const box = await s("DOM.getBoxModel", { nodeId: await q("#f") });
const [x1, y1] = box.model.content;
await s("Input.dispatchMouseEvent", { type: "mousePressed", x: x1 + 5, y: y1 + 5, button: "left", clickCount: 1 });
await s("Input.dispatchMouseEvent", { type: "mouseReleased", x: x1 + 5, y: y1 + 5, button: "left", clickCount: 1 });
await wait(800);
console.log("chooser events", events.filter((e) => e.method === "Page.fileChooserOpened").map((e) => JSON.stringify(e.params)));
// download
const a = await q("a");
const ab = await s("DOM.getBoxModel", { nodeId: a });
await s("Input.dispatchMouseEvent", { type: "mousePressed", x: ab.model.content[0] + 2, y: ab.model.content[1] + 2, button: "left", clickCount: 1 });
await s("Input.dispatchMouseEvent", { type: "mouseReleased", x: ab.model.content[0] + 2, y: ab.model.content[1] + 2, button: "left", clickCount: 1 });
await wait(1500);
console.log("download events", events.filter((e) => e.method?.startsWith("Browser.download")).map((e) => `${e.method} ${JSON.stringify(e.params).slice(0, 200)}`));
try { console.log("dl dir", readdirSync("/tmp/job-plan-part8/dl")); } catch (e) { console.log("no dl dir", e.message); }
for (const url of ["chrome://settings/cookies", "javascript:document.title='LEAK'", "view-source:http://127.0.0.1:" + port + "/", "file:///etc/passwd", "devtools://devtools/bundled/inspector.html"]) {
  try { const r = await s("Page.navigate", { url }); console.log("nav", url, JSON.stringify(r)); } catch (e) { console.log("nav err", url, e.message); }
  await wait(500);
}
console.log("title after js nav", (await s("Accessibility.getFullAXTree")).nodes.find((n) => n.role?.value === "RootWebArea")?.name?.value);
c.proc.kill("SIGKILL"); server.close();
