import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fmt, stats } from "./xi.mjs";

// usage: node summary.mjs out/<run>.json... — pools raw->frame over measure and inputs runs of one scale.
const FRAME_MS = 1000 / 60;
const frame = [];
const received = [];
for (const file of process.argv.slice(2)) {
  const rows = JSON.parse(readFileSync(file, "utf8")).rows.filter((r) => Number.isFinite(r.raw) && Number.isFinite(r.frame));
  frame.push(...rows.map((r) => r.frame - r.raw));
  received.push(...rows.map((r) => r.received - r.raw));
  console.log(`${basename(file)}: raw->frame ${fmt(stats(rows.map((r) => r.frame - r.raw)))}`);
}
const s = stats(frame);
console.log(`pooled raw->frame    ${fmt(s)}`);
console.log(`pooled raw->received ${fmt(stats(received))}`);
const within = frame.filter((l) => Math.abs(l - s.p50) <= FRAME_MS).length;
console.log(`C = p50 = ${s.p50.toFixed(1)} ms: ${within}/${frame.length} trials within one 60 Hz frame (±${FRAME_MS.toFixed(1)} ms); error ${(s.min - s.p50).toFixed(1)} to +${(s.max - s.p50).toFixed(1)} ms`);
