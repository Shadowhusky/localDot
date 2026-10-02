import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
export function launch({ display = ":187", extra = [], profile } = {}) {
  const dir = profile ?? mkdtempSync(join(tmpdir(), "ldprof-"));
  const p = spawn(CHROME, [
    "--remote-debugging-pipe", `--user-data-dir=${dir}`, "--no-sandbox", "--no-first-run",
    "--no-default-browser-check", "--disable-gpu", "--disable-background-networking", "--disable-component-update", "--proxy-server=http://127.0.0.1:9", "--disable-features=OptimizationHints,MediaRouter", "--window-position=0,0", "--window-size=1280,800",
    ...extra, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], env: { ...process.env, DISPLAY: display } });
  let stderr = "";
  p.stdio[2].on("data", (d) => { stderr += d; });
  const out = p.stdio[3];
  const inp = p.stdio[4];
  let buf = Buffer.alloc(0);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  inp.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (let i = buf.indexOf(0); i >= 0; i = buf.indexOf(0)) {
      const msg = JSON.parse(buf.subarray(0, i).toString());
      buf = buf.subarray(i + 1);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message}`)) : resolve(msg.result);
      } else for (const l of listeners) l(msg);
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const m = { id: ++id, method, params, ...(sessionId ? { sessionId } : {}) };
      pending.set(m.id, { resolve, reject });
      out.write(`${JSON.stringify(m)}\0`);
    });
  return { proc: p, send, on: (l) => listeners.push(l), dir, stderr: () => stderr };
}

export function serve(routes) {
  const server = createServer((req, res) => {
    const r = routes[req.url.split("?")[0]];
    if (!r) { res.writeHead(404); return res.end("nf"); }
    res.writeHead(200, r.headers ?? { "content-type": "text/html" });
    res.end(r.body);
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, port: server.address().port })));
}
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
