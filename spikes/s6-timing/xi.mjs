import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

export const DESKTOP = process.env.LD_DESKTOP ?? "ld-s6-desktop";
export const now = () => performance.timeOrigin + performance.now();

export function stats(xs) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  const pct = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  return { n: s.length, p50: pct(50), p95: pct(95), min: s[0], max: s.at(-1) };
}

export const fmt = ({ n, p50, p95, min, max }) =>
  n ? `n=${n} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms min=${min.toFixed(1)}ms max=${max.toFixed(1)}ms` : "n=0";

// Raw XI2 events from xilog.py inside the desktop, plus clock pings over the same pipe.
export function startXi() {
  const proc = spawn("docker", ["exec", "-i", "-u", "abc", "-e", "DISPLAY=:1", DESKTOP, "/usr/bin/python3", "-u", "/tmp/xilog.py"]);
  const events = [];
  const waiting = new Map();
  createInterface({ input: proc.stdout }).on("line", (line) => {
    const got = now();
    const msg = JSON.parse(line);
    if ("pong" in msg) {
      waiting.get(msg.pong)?.({ ...msg, got });
      waiting.delete(msg.pong);
    } else events.push(msg);
  });
  proc.stderr.on("data", (d) => process.stderr.write(`xilog: ${d}`));
  let seq = 0;
  const ping = () =>
    new Promise((resolve) => {
      const id = String(seq++);
      const sent = now();
      waiting.set(id, (msg) => resolve({ ...msg, sent }));
      proc.stdin.write(`${id}\n`);
    });
  // offset = container CLOCK_REALTIME minus host clock, taken from the lowest-RTT ping.
  const sync = async (n = 40) => {
    const samples = [];
    for (let i = 0; i < n; i++) {
      const p = await ping();
      samples.push({ rtt: p.got - p.sent, offset: p.real - (p.sent + p.got) / 2, monoMinusReal: p.mono - p.real });
      await sleep(15);
    }
    const byRtt = [...samples].sort((a, b) => a.rtt - b.rtt);
    const best = byRtt[0];
    const fast = byRtt.slice(0, 10).map((s) => s.offset);
    return { ...best, rttP50: stats(samples.map((s) => s.rtt)).p50, offsetSpread10: Math.max(...fast) - Math.min(...fast) };
  };
  return { events, sync, stop: () => proc.stdin.end() };
}
