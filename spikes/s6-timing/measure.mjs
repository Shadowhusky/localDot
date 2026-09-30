import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { flips, startCollector } from "./collector.mjs";
import { DESKTOP, fmt, now, startXi, stats } from "./xi.mjs";

const trials = Number(process.argv[2] ?? 50);
const label = process.argv[3] ?? "key";
const screen = execFileSync("docker", ["exec", "-u", "abc", "-e", "DISPLAY=:1", DESKTOP, "xdotool", "getdisplaygeometry"]).toString().trim().replace(" ", "x");
const collector = startCollector();
const xi = startXi();
const xdo = spawn("docker", ["exec", "-i", "-u", "abc", "-e", "DISPLAY=:1", DESKTOP, "xdotool", "-"]);
const sent = [];
await sleep(1000);
// A still screen sends no frames, so the detector has no baseline until the first change: one untimed key.
xdo.stdin.write("key space\n");
await sleep(600);
const before = await xi.sync();
for (let i = 0; i < trials; i++) {
  sent.push(now());
  xdo.stdin.write("key space\n");
  // 400 ms is exactly 24 frames at 60 Hz; up to one frame of jitter spreads the sends over the capture phase.
  await sleep(400 + Math.random() * 16.7);
}
await sleep(1000);
const after = await xi.sync();
const offset = (before.offset + after.offset) / 2;
const presses = xi.events.filter((e) => e.type === "RawKeyPress").map((e) => ({ ...e, host: e.real - offset }));
const shown = flips.filter((f) => f.kind === "presented");
const rows = sent.map((s, i) => {
  const end = sent[i + 1] ?? s + 1000;
  const flip = flips.find((f) => f.kind === "flip" && f.at > s && f.at < end);
  const raw = presses.find((e) => e.host > s - 2 && e.host < end);
  return {
    sent: s,
    raw: raw?.host,
    xserver: raw && raw.xtime - before.monoMinusReal - offset,
    received: flip?.received,
    frame: flip?.at,
    displayed: flip && shown.find((p) => p.ts === flip.ts)?.expected,
  };
});
const span = (a, b) => stats(rows.map((r) => r[b] - r[a]));
const lat = sent.map((s, i) => rows[i].frame - s).filter(Number.isFinite).sort((a, b) => a - b);
const pct = (p) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))].toFixed(1);
console.log(`n=${lat.length}/${trials} p50=${pct(50)}ms p95=${pct(95)}ms min=${lat[0].toFixed(1)}ms`);
console.log(`send->raw        ${fmt(span("sent", "raw"))}`);
console.log(`raw->frame       ${fmt(span("raw", "frame"))}`);
console.log(`raw->received    ${fmt(span("raw", "received"))}`);
console.log(`received->frame  ${fmt(span("received", "frame"))}`);
console.log(`frame->displayed ${fmt(span("frame", "displayed"))}`);
console.log(`xserver->raw     ${fmt(span("xserver", "raw"))}`);
const flipCount = flips.filter((f) => f.kind === "flip").length;
console.log(`flips ${flipCount} for ${trials} keys; raw presses ${presses.length}; clock offset ${before.offset.toFixed(2)} -> ${after.offset.toFixed(2)} ms (min rtt ${before.rtt.toFixed(2)} / ${after.rtt.toFixed(2)} ms)`);
console.log(`raw->frame ms: ${rows.map((r) => (r.frame - r.raw).toFixed(1)).join(" ")}`);
mkdirSync(new URL("./out/", import.meta.url), { recursive: true });
writeFileSync(new URL(`./out/measure-${screen}-${label}-${Date.now()}.json`, import.meta.url), JSON.stringify({ screen, label, trials, before, after, rows, flips, events: xi.events }, null, 1));
xdo.stdin.end();
xi.stop();
collector.close();
await sleep(300);
process.exit(0);
