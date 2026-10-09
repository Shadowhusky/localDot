import { GRAPHITE, Sheet, SOFT, XENON } from "./sketch.mjs";

const BEFORE = { fill: GRAPHITE, fillWeight: 1, hachureGap: 8, strokeWidth: 2 };
const AFTER = { fill: XENON, fillWeight: 1.8, hachureGap: 6, strokeWidth: 2 };

function legend(s, x, y, before, after) {
  s.rect(x, y - 20, 34, 24, BEFORE);
  s.text(before, x + 46, y, { size: 24 });
  const next = x + 46 + s.measure(before, 24) + 40;
  s.rect(next, y - 20, 34, 24, AFTER);
  s.text(after, next + 46, y, { size: 24 });
}

function screenshots() {
  const s = new Sheet(1500, 1000);
  s.text("Fewer screenshots, same work", 60, 82, { size: 50, bold: true });
  s.text("pictures sent to the model across 7 desktop tasks, before and after batching", 64, 124, {
    size: 24,
    color: SOFT,
  });
  legend(s, 64, 186, "before", "after");
  const rows = [
    ["fill in a spreadsheet", 6, 5],
    ["drag a file into a folder", 2, 2],
    ["select a few files", 7, 7],
    ["draw a shape in GIMP", 52, 8],
    ["pick a colour in GIMP", 12, 10],
    ["edit text by keyboard", 14, 10],
    ["fill in a web form", 14, 8],
  ];
  const left = 450;
  const unit = 15;
  rows.forEach(([label, before, after], i) => {
    const y = 236 + i * 90;
    s.text(label, left - 24, y + 36, { size: 27, anchor: "end" });
    s.rect(left, y + 4, before * unit, 26, BEFORE);
    s.text(String(before), left + before * unit + 14, y + 27, { size: 24, color: SOFT });
    s.rect(left, y + 38, after * unit, 26, AFTER);
    s.text(String(after), left + after * unit + 14, y + 61, { size: 24, bold: true });
  });
  s.line(left, 226, left, 880, { strokeWidth: 2 });

  s.rect(980, 650, 470, 200, { strokeWidth: 2.2 });
  s.text("107", 1150, 718, { size: 52, bold: true, anchor: "end" });
  s.arrow(
    [
      [1168, 702],
      [1196, 698],
      [1226, 702],
    ],
    { strokeWidth: 3, stroke: XENON },
  );
  s.text("50", 1244, 718, { size: 52, bold: true });
  s.text("screenshots in total.\nsame 51 turns, same 107 actions.", 1215, 764, {
    size: 24,
    anchor: "middle",
  });
  s.text("and with batched actions, that web form takes 3 model turns instead of 8.", 64, 940, {
    size: 25,
  });
  return { sheet: s, title: "Fewer screenshots, same work" };
}

function exports() {
  const s = new Sheet(1500, 660);
  s.text("Exporting a 2-minute recording", 60, 82, { size: 50, bold: true });
  s.text(
    "seconds to make the file, shorter is better (M3 Ultra, Chrome, hardware H.264)",
    64,
    124,
    {
      size: 24,
      color: SOFT,
    },
  );
  const rows = [
    ["the old exporter", "1080p, 30 fps", 25.7, "7.5 MB", BEFORE],
    ["Quality", "2560x1600, 60 fps", 5.9, "13.1 MB", AFTER],
    ["Fast", "1280x800, 15 fps", 1.4, "1.7 MB", AFTER],
  ];
  const left = 470;
  const unit = 30;
  rows.forEach(([name, detail, seconds, size, style], i) => {
    const y = 190 + i * 130;
    s.text(name, left - 26, y + 40, { size: 32, bold: true, anchor: "end" });
    s.text(detail, left - 26, y + 74, { size: 22, anchor: "end", color: SOFT });
    s.rect(left, y + 14, seconds * unit, 52, style);
    s.text(`${seconds} s  ·  ${size}`, left + seconds * unit + 18, y + 50, {
      size: 28,
      bold: style === AFTER,
    });
  });
  s.line(left, 180, left, 580, { strokeWidth: 2 });
  s.text("Fast is 4.2x quicker and 7.9x smaller than Quality.", 64, 620, { size: 26 });
  return { sheet: s, title: "Exporting a 2-minute recording" };
}

function stream() {
  const s = new Sheet(1500, 800);
  s.text("The live picture on a squeezed link", 60, 82, { size: 50, bold: true });
  s.text("5 Mbps, 80 ms round trip, a scrolling 2560x1600 page in desktop Chrome", 64, 124, {
    size: 24,
    color: SOFT,
  });
  legend(s, 64, 186, "fixed quality (before)", "adaptive quality (after)");
  const base = 640;
  const panel = (x, title, note, before, after, max, unit) => {
    s.text(title, x + 260, 260, { size: 30, bold: true, anchor: "middle" });
    s.text(note, x + 260, 294, { size: 22, anchor: "middle", color: SOFT });
    s.line(x, base, x + 520, base, { strokeWidth: 2 });
    const h = (v) => (v / max) * 300;
    s.rect(x + 70, base - h(before), 140, h(before), BEFORE);
    s.text(`${before}${unit}`, x + 140, base - h(before) - 16, { size: 30, anchor: "middle" });
    s.rect(x + 310, base - h(after), 140, h(after), AFTER);
    s.text(`${after}${unit}`, x + 380, base - h(after) - 16, {
      size: 30,
      bold: true,
      anchor: "middle",
    });
    s.text("before", x + 140, base + 40, { size: 24, anchor: "middle", color: SOFT });
    s.text("after", x + 380, base + 40, { size: 24, anchor: "middle", color: SOFT });
  };
  panel(80, "new frames per second", "taller is better", 10.9, 57.3, 60, "");
  panel(
    860,
    "key press to screen",
    "median while scrolling, shorter is better",
    1371,
    116,
    1400,
    " ms",
  );
  s.text("before, 9 of 10 key presses took over 2 seconds to show up. after, none did.", 64, 760, {
    size: 25,
  });
  return { sheet: s, title: "The live picture on a squeezed link" };
}

export const charts = {
  "chart-screenshots": screenshots,
  "chart-export": exports,
  "chart-stream": stream,
};
