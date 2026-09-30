import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { flips, startCollector } from "./collector.mjs";
import { DESKTOP, fmt, now, startXi, stats } from "./xi.mjs";

// usage: node inputs.mjs <xdo|xtest|cua> <click|type> <flash|flash-up|mousepad> [trials]
// xdo is the xdotool recipe with --sync waits; xtest (click only) activates without waiting and clicks with --delay 0.
// flash-up needs the page opened with `setup.sh up`. LD_CUA_ENV="NAME=value ..." adds driver environment.
// LD_HOLD_MS holds the xtest click's button down for that long instead of releasing it at once.
const [path, action, target] = process.argv.slice(2, 5);
const trials = Number(process.argv[5] ?? 30);
const DRIVER = "/opt/venv/lib/python3.14/site-packages/cua_driver/bin/cua-driver";
const TEXT = "x";
const TITLES = { flash: "^flash - Chromium$", "flash-up": "^flash up - Chromium$", mousepad: "Mousepad$" };
const cuaEnv = (process.env.LD_CUA_ENV ?? "").split(" ").filter(Boolean);
const holdMs = Number(process.env.LD_HOLD_MS ?? 0);

const sh = (cmd) => execFileSync("docker", ["exec", "-u", "abc", "-e", "DISPLAY=:1", DESKTOP, "sh", "-c", cmd]).toString().trim();
const dbus = sh(`tr "\\0" "\\n" < /proc/$(pgrep -u abc -n xfce4-session)/environ`).match(/^DBUS_SESSION_BUS_ADDRESS=(.*)$/m)[1];
const onLines = (proc, fn) => createInterface({ input: proc.stdout }).on("line", (line) => fn(line, now()));
// performance.now()'s wall clock minus Date.now(), read at each Date.now() tick edge for 20 ms.
const clockSkew = () => {
  const d = [];
  let prev = Date.now();
  for (const stop = now() + 20; now() < stop; ) {
    const t = Date.now();
    if (t !== prev) d.push(now() - t);
    prev = t;
  }
  return d.reduce((a, b) => a + b, 0) / d.length;
};
const waitFor = async (fn, ms) => {
  for (const end = now() + ms; now() < end; await sleep(5)) {
    const hit = fn();
    if (hit) return hit;
  }
};

function startXdo() {
  const proc = spawn("docker", ["exec", "-i", "-u", "abc", "-e", "DISPLAY=:1", DESKTOP, "stdbuf", "-oL", "xdotool", "-"]);
  const waiting = [];
  onLines(proc, (line, got) => waiting.shift()?.({ line, got }));
  proc.stderr.on("data", (d) => process.stderr.write(`xdotool: ${d}`));
  // getmouselocation prints one line, after every command before it has run.
  const run = (cmds) =>
    new Promise((resolve) => {
      waiting.push(resolve);
      proc.stdin.write(`${cmds.join("\n")}\ngetmouselocation\n`);
    });
  return { run, stop: () => proc.stdin.end() };
}

function startCua() {
  const proc = spawn("docker", ["exec", "-i", "-u", "abc", "-e", "DISPLAY=:1", "-e", `DBUS_SESSION_BUS_ADDRESS=${dbus}`,
    "-e", "CUA_DRIVER_RS_TELEMETRY_ENABLED=0", "-e", "CUA_DRIVER_RS_UPDATE_CHECK=0", ...cuaEnv.flatMap((v) => ["-e", v]),
    DESKTOP, DRIVER, "mcp", "--no-overlay"]);
  const pending = new Map();
  const stderr = [];
  let seq = 0;
  onLines(proc, (line, got) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    pending.get(msg.id)?.({ ...msg, got });
    pending.delete(msg.id);
  });
  proc.stderr.on("data", (d) => stderr.push(d.toString()));
  const send = (msg) => proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      send({ id, method, params });
    });
  const call = async (name, args) => {
    const r = await request("tools/call", { name, arguments: args });
    if (r.error || r.result?.isError) throw new Error(`${name}: ${JSON.stringify(r.error ?? r.result)}`);
    return r.result;
  };
  const init = async () => {
    const r = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "localdot-s6", version: "0.0.0" } });
    send({ method: "notifications/initialized" });
    return r.result;
  };
  return { init, call, stderr, stop: () => proc.stdin.end() };
}

const timeKeys = (obj, at = "") =>
  obj && typeof obj === "object"
    ? Object.entries(obj).flatMap(([k, v]) => [
        ...(/time|stamp|(^|_)ts$|_at$|(^|_)ms$|_ns$|_us$/i.test(k) ? [`${at}${k}=${JSON.stringify(v)}`] : []),
        ...timeKeys(v, `${at}${k}.`),
      ])
    : [];

const screen = sh("xdotool getdisplaygeometry").replace(" ", "x");
const wid = Number(sh(`xdotool search --onlyvisible --name '${TITLES[target]}' | head -1`));
const pid = Number(sh(`xdotool getwindowpid ${wid}`));
const geo = sh(`xdotool getwindowgeometry --shell ${wid}`);
const [x, y, w, h] = ["X", "Y", "WIDTH", "HEIGHT"].map((k) => Number(geo.match(new RegExp(`^${k}=(\\d+)`, "m"))[1]));
const points = [-1, 1].map((side) => [Math.round(x + w / 2 + (side * w) / 32), Math.round(y + h / 2)]);

const hostSkew = [clockSkew()];
const collector = startCollector();
const xi = startXi();
const xdo = startXdo();
const cua = path === "cua" ? startCua() : null;
const serverInfo = await cua?.init();
const act = {
  xdo: {
    click: (p) => xdo.run([`windowactivate --sync ${wid}`, `mousemove --sync ${p[0]} ${p[1]} click 1`]),
    type: () => xdo.run([`windowactivate --sync ${wid}`, `type ${TEXT}`]),
  },
  xtest: {
    click: (p) => xdo.run([`windowactivate ${wid} mousemove ${p[0]} ${p[1]} ${holdMs ? `mousedown 1 sleep ${holdMs / 1000} mouseup 1` : "click --delay 0 1"}`]),
  },
  cua: {
    click: (p) => cua.call("click", { pid, window_id: wid, x: p[0], y: p[1], coordinate_frame: "desktop", delivery_mode: "foreground" }),
    type: () => cua.call("type_text", { pid, window_id: wid, text: TEXT, delivery_mode: "foreground" }),
  },
}[path][action];

const trial = async (i) => {
  const sent = now();
  const result = await act(points[i % 2]);
  const returned = now();
  const flip = await waitFor(() => flips.find((f) => f.kind === "flip" && f.at > sent), 3000);
  if (target === "mousepad") {
    await xdo.run(["key BackSpace"]);
    await waitFor(() => flips.find((f) => f.kind === "flip" && f.at > (flip?.at ?? sent)), 1000);
  }
  return { sent, returned, result };
};

await sleep(1000);
await trial(0);
await sleep(600);
const before = await xi.sync();
const runs = [];
for (let i = 0; i < trials; i++) {
  runs.push(await trial(i + 1));
  await sleep(400 + Math.random() * 16.7);
}
await sleep(500);
const after = await xi.sync();
hostSkew.push(clockSkew());
const offset = (before.offset + after.offset) / 2;
const rawType = action === "click" ? "RawButtonPress" : "RawKeyPress";
const releaseType = action === "click" ? "RawButtonRelease" : "RawKeyRelease";
const events = xi.events.map((e) => ({ ...e, host: e.real - offset }));
const rows = runs.map((r, i) => {
  const end = runs[i + 1]?.sent ?? r.sent + 3000;
  const inWindow = events.filter((e) => e.host > r.sent - 2 && e.host < end);
  const raw = inWindow.find((e) => e.type === rawType);
  const release = raw && inWindow.find((e) => e.type === releaseType && e.detail === raw.detail && e.host >= raw.host);
  const flip = flips.find((f) => f.kind === "flip" && f.at > r.sent && f.at < end);
  return {
    sent: r.sent,
    raw: raw?.host,
    release: release?.host,
    frame: flip?.at,
    received: flip?.received,
    returned: r.returned,
    events: inWindow.filter((e) => e.type !== "RawMotion").map((e) => `${e.type}:${e.detail}@${(e.host - r.sent).toFixed(1)}`),
  };
});
const span = (a, b) => stats(rows.map((r) => r[b] - r[a]));
const first = runs[0].result;
console.log(`${path} ${action} ${target} (window ${wid}, pid ${pid}, ${w}x${h}+${x}+${y}), ${trials} trials${cuaEnv.length ? `, ${cuaEnv.join(" ")}` : ""}${holdMs ? `, hold ${holdMs} ms` : ""}`);
console.log(`send->raw      ${fmt(span("sent", "raw"))}`);
console.log(`send->release  ${fmt(span("sent", "release"))}`);
console.log(`raw->frame     ${fmt(span("raw", "frame"))}`);
console.log(`release->frame ${fmt(span("release", "frame"))}`);
console.log(`raw->received  ${fmt(span("raw", "received"))}`);
console.log(`send->frame    ${fmt(span("sent", "frame"))}`);
console.log(`send->return   ${fmt(span("sent", "returned"))}`);
console.log(`raw->return    ${fmt(span("raw", "returned"))}`);
console.log(`frame->return  ${fmt(span("frame", "returned"))}`);
console.log(`time-like fields in the call result: ${path === "cua" ? timeKeys(first).join(", ") || "none" : "n/a (xdotool prints nothing)"}`);
if (path === "cua") console.log(`result text: ${(first.content ?? []).map((c) => c.text).join(" | ")}`);
console.log(`events in trial 1: ${rows[0].events.join(" ")}`);
console.log(`clock offset ${before.offset.toFixed(2)} -> ${after.offset.toFixed(2)} ms (min rtt ${before.rtt.toFixed(2)} / ${after.rtt.toFixed(2)} ms)`);
const viewerSkew = flips.filter((f) => f.kind === "flip" && Number.isFinite(f.skew)).map((f) => f.skew);
console.log(`clock skew (perf wall - Date.now) host ${hostSkew.map((v) => v.toFixed(2)).join(" -> ")} ms, viewer ${viewerSkew.length ? `${Math.min(...viewerSkew).toFixed(2)}..${Math.max(...viewerSkew).toFixed(2)}` : "n/a"} ms`);
console.log(`raw->frame ms: ${rows.map((r) => (r.frame - r.raw).toFixed(1)).join(" ")}`);
mkdirSync(new URL("./out/", import.meta.url), { recursive: true });
writeFileSync(new URL(`./out/inputs-${screen}-${path}-${action}-${target}-${Date.now()}.json`, import.meta.url),
  JSON.stringify({ screen, path, action, target, cuaEnv, holdMs, hostSkew, wid, pid, geometry: { x, y, w, h }, points, serverInfo, before, after, rows, results: runs.map((r) => r.result), flips, events: xi.events, driverStderr: cua?.stderr }, null, 1));
xdo.stop();
cua?.stop();
xi.stop();
collector.close();
await sleep(300);
process.exit(0);
