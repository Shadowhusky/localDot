import { readFileSync } from "node:fs";
import { basename } from "node:path";

// usage: node summary.mjs export out/*.json > trials.csv   one row per trial from measure.mjs and inputs.mjs runs
//        node summary.mjs [trials.csv]                     latency per injector and ring-onset tables, per scale
const FRAME_MS = 1000 / 60;
const INJECTORS = { xdo: "xdotool --sync", xtest: "own XTest", cua: "driver" };
const COLUMNS = ["scale", "injector", "action", "effect", "watch_ms", "run", "trial", "send_press", "send_release",
  "press_frame", "release_frame", "press_chunk", "send_return", "viewer_skew", "host_skew"];
const fixed = (x, digits = 2) => (Number.isFinite(x) ? x.toFixed(digits) : "");
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

if (process.argv[2] === "export") exportRuns(process.argv.slice(3));
else report(process.argv[2] ?? new URL("./trials.csv", import.meta.url));

function exportRuns(files) {
  const lines = [COLUMNS.join(",")];
  for (const file of files) {
    const run = JSON.parse(readFileSync(file, "utf8"));
    const measured = "label" in run;
    const click = run.action === "click";
    const effect = click ? (run.target === "flash-up" ? "mouseup" : "mousedown") : run.target === "mousepad" ? "glyph" : "keydown";
    const offset = (run.before.offset + run.after.offset) / 2;
    const events = run.events.map((e) => ({ ...e, host: e.real - offset }));
    const hostSkew = run.hostSkew ? run.hostSkew.reduce((a, b) => a + b, 0) / run.hostSkew.length : Number.NaN;
    const meta = [(run.screen ?? basename(file).match(/\d+x\d+/)[0]) === "2560x1600" ? "2x" : "1x",
      measured ? "bare key" : `${INJECTORS[run.path]}${run.holdMs ? ` ${run.holdMs} ms hold` : ""}`, measured ? "key" : run.action,
      measured ? "keydown" : effect,
      run.path === "cua" ? (run.cuaEnv.length ? 0 : 800) : "", basename(file, ".json")];
    run.rows.forEach((row, i) => {
      const end = run.rows[i + 1]?.sent ?? row.sent + 3000;
      const press = events.find((e) => e.type === (click ? "RawButtonPress" : "RawKeyPress") && e.host > row.sent - 2 && e.host < end);
      const release = press && events.find((e) => e.type === (click ? "RawButtonRelease" : "RawKeyRelease") && e.detail === press.detail
        && e.host >= press.host && e.host < end);
      const flip = run.flips.find((f) => f.kind === "flip" && f.at === row.frame);
      lines.push([...meta, i + 1, fixed(press?.host - row.sent), fixed(release?.host - row.sent), fixed(row.frame - press?.host),
        fixed(row.frame - release?.host), fixed(row.received - press?.host), fixed(row.returned - row.sent), fixed(flip?.skew),
        fixed(hostSkew)].join(","));
    });
  }
  console.log(lines.join("\n"));
}

function report(csv) {
  const [head, ...rows] = readFileSync(csv, "utf8").trim().split("\n").map((line) => line.split(","));
  const trials = rows.map((r) => Object.fromEntries(head.map((k, i) => [k, r[i] === "" ? Number.NaN : Number.isNaN(Number(r[i])) ? r[i] : Number(r[i])])));
  const name = (t) => (t.action === "key" ? t.injector : `${t.injector} ${t.action === "click" ? `click, ${t.effect}` : "key/type"}`);
  const groups = Map.groupBy(trials, (t) => `${t.scale}|${name(t)}`);
  const median = (xs) => pct(xs.filter(Number.isFinite).sort((a, b) => a - b), 50);
  for (const scale of ["1x", "2x"]) {
    const mine = [...groups].filter(([key]) => key.startsWith(`${scale}|`)).map(([key, ts]) => [key.split("|")[1], ts]);
    console.log(`\n${scale}: press -> frame (ms), and p50 of the other spans`);
    console.log("| injector | n | p5 | p25 | p50 | p75 | p95 | p99 | max | send→press | press→release | release→frame |");
    console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const [name, ts] of mine) {
      const l = ts.map((t) => t.press_frame).filter(Number.isFinite).sort((a, b) => a - b);
      const q = [5, 25, 50, 75, 95, 99].map((p) => fixed(pct(l, p), 1));
      const hold = ts.map((t) => t.send_release - t.send_press);
      console.log(`| ${name} | ${l.length} | ${q.join(" | ")} | ${fixed(l.at(-1), 1)} | ${fixed(median(ts.map((t) => t.send_press)), 1)} | ${fixed(median(hold), 1)} | ${fixed(median(ts.map((t) => t.release_frame)), 1)} |`);
    }
    console.log(`\n${scale}: ring onset at press + C. Early = the ring starts before the frame showing the input (L > C); late = after it.`);
    console.log("| injector | C | ms | early | max early | > 1 frame early | max late | > 1 frame late |");
    console.log("|---|---|---|---|---|---|---|---|");
    for (const [name, ts] of mine) {
      const l = ts.map((t) => t.press_frame).filter(Number.isFinite).sort((a, b) => a - b);
      for (const [label, c] of [["p50", pct(l, 50)], ["p95", pct(l, 95)], ["p99", pct(l, 99)], ["max", l.at(-1)]]) {
        const early = l.filter((x) => x > c).map((x) => x - c);
        const late = l.filter((x) => x < c).map((x) => c - x);
        const most = (xs) => (xs.length ? fixed(Math.max(...xs), 1) : "0");
        console.log(`| ${name} | ${label} | ${fixed(c, 1)} | ${early.length}/${l.length} | ${most(early)} | ${early.filter((x) => x > FRAME_MS).length} | ${most(late)} | ${late.filter((x) => x > FRAME_MS).length} |`);
      }
    }
    console.log(`\n${scale}: a click on a control that acts on release, with C from the same injector's mousedown p99`);
    console.log("| injector | C | early | max early | > 1 frame early | max late |");
    console.log("|---|---|---|---|---|---|");
    for (const [name, ts] of mine.filter(([n]) => n.endsWith("click, mouseup"))) {
      const down = mine.find(([n]) => n === name.replace("mouseup", "mousedown"));
      if (!down) continue;
      const c = pct(down[1].map((t) => t.press_frame).filter(Number.isFinite).sort((a, b) => a - b), 99);
      const l = ts.map((t) => t.press_frame).filter(Number.isFinite);
      const early = l.filter((x) => x > c).map((x) => x - c);
      const late = l.filter((x) => x < c).map((x) => c - x);
      console.log(`| ${name} | ${fixed(c, 1)} | ${early.length}/${l.length} | ${fixed(Math.max(0, ...early), 1)} | ${early.filter((x) => x > FRAME_MS).length} | ${fixed(Math.max(0, ...late), 1)} |`);
    }
  }
}
