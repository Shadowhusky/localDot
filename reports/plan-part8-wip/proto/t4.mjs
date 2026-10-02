import { launch, serve, wait } from "./cdp.mjs";
import { writeFileSync } from "node:fs";
const page = `<!doctype html><title>Login</title><form action=/next><input id=u name=u><input id=p name=p type=password><input id=f type=file></form>`;
const { server, port } = await serve({ "/": { body: page } });
const c = launch();
const ev = []; c.on((m) => ev.push(m));
await wait(1200);
const { targetId } = await c.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
const s = (m, p) => c.send(m, p, sessionId);
await s("Page.enable");
await s("Page.setInterceptFileChooserDialog", { enabled: true });
await s("Page.navigate", { url: `http://127.0.0.1:${port}/` });
await wait(800);
const typeInto = async (sel, text) => {
  const doc = await s("DOM.getDocument", { depth: -1 });
  const { nodeId } = await s("DOM.querySelector", { nodeId: doc.root.nodeId, selector: sel });
  await s("DOM.focus", { nodeId });
  for (const ch of text) await s("Input.dispatchKeyEvent", { type: "keyDown", text: ch });
};
await typeInto("#u", "alice"); await typeInto("#p", "hunter2");
const vals = async () => (await s("Accessibility.getFullAXTree")).nodes.filter((n) => n.role?.value === "textbox").map((n) => JSON.stringify(n.value?.value ?? null)).join(",");
console.log("before reload", await vals());
await s("Page.reload"); await wait(1000);
console.log("after reload", await vals());
// file chooser -> setFileInputFiles
writeFileSync("/tmp/job-plan-part8/up.txt", "upload me");
const doc = await s("DOM.getDocument", { depth: -1 });
const { nodeId } = await s("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#f" });
const box = (await s("DOM.getBoxModel", { nodeId })).model.content;
for (const type of ["mousePressed", "mouseReleased"]) await s("Input.dispatchMouseEvent", { type, x: box[0] + 4, y: box[1] + 4, button: "left", clickCount: 1 });
await wait(500);
const fc = ev.find((e) => e.method === "Page.fileChooserOpened");
console.log("chooser", JSON.stringify(fc?.params));
try { await s("DOM.setFileInputFiles", { files: ["/tmp/job-plan-part8/up.txt"], backendNodeId: fc.params.backendNodeId }); console.log("set ok"); } catch (e) { console.log("set err", e.message); }
const ax = await s("Accessibility.getFullAXTree");
console.log("file input AX", ax.nodes.filter((n) => /button|file/i.test(n.role?.value ?? "") ).map((n) => `${n.role.value}:${n.name?.value}:${n.value?.value ?? ""}`).join(" | "));
// node location hit test in CSS px
const loc = await s("DOM.getNodeForLocation", { x: box[0] + 4, y: box[1] + 4, includeUserAgentShadowDOM: false });
console.log("hit", JSON.stringify(loc));
const lm = await s("Page.getLayoutMetrics");
const win = await c.send("Browser.getWindowForTarget", { targetId });
console.log("layout", JSON.stringify(lm.cssLayoutViewport), JSON.stringify(win.bounds));
c.proc.kill("SIGKILL"); server.close();
