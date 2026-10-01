// S6's send → frame method on the S8 tap. A persistent `xdotool -` in the desktop presses
// `key space` <n> times, ~600 ms apart so the server's paint-over frames (S6: 285–365 ms after a
// change) settle before the next press. The flash page (spikes/s6-timing/flash.html, in a normal
// window: fullscreen windows bypass the compositor) flips on each press. Prints the send times
// for recorder.js's ldLatency(sent).
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const n = Number(process.argv[2] ?? 60);
const xdo = spawn("docker", ["exec", "-i", "-u", "abc", "-e", "DISPLAY=:1", "ld-s8-desktop", "xdotool", "-"]);
xdo.stderr.on("data", (d) => process.stderr.write(d));
await sleep(1000);
// A still screen sends no frames, so one untimed press gives the stream a baseline first.
xdo.stdin.write("key space\n");
await sleep(700);
const sent = [];
for (let i = 0; i < n; i++) {
  sent.push(Date.now());
  xdo.stdin.write("key space\n");
  await sleep(600 + Math.random() * 16.7);
}
await sleep(800);
xdo.stdin.end();
console.log(JSON.stringify(sent));
process.exit(0);
