import { GRAPHITE, PAPER, Sheet, SOFT, XENON } from "./sketch.mjs";

const xenonFill = { fill: XENON, fillWeight: 1.6, hachureGap: 8 };

function dotFace(s, cx, cy, d, options = {}) {
  s.circle(cx, cy, d, { strokeWidth: 2.4, ...options });
  const eye = d * 0.11;
  for (const dx of [-0.13, 0.13])
    s.ellipse(cx + dx * d, cy - d * 0.04, eye, eye * 1.9, {
      fill: GRAPHITE,
      fillStyle: "solid",
      roughness: 0.6,
      strokeWidth: 1.5,
    });
}

function laptop(s, x, y) {
  s.rounded(x, y, 190, 120, 10, { strokeWidth: 2.4 });
  s.rect(x + 14, y + 14, 162, 92, { strokeWidth: 1.4, roughness: 1 });
  s.polygon(
    [
      [x - 18, y + 132],
      [x + 208, y + 132],
      [x + 226, y + 150],
      [x - 36, y + 150],
    ],
    { strokeWidth: 2.4 },
  );
}

function phone(s, x, y) {
  s.rounded(x, y, 74, 136, 14, { strokeWidth: 2.4 });
  s.line(x + 26, y + 12, x + 48, y + 12, { strokeWidth: 2 });
}

function windowDoodle(s, x, y, w, h) {
  s.rect(x, y, w, h, { strokeWidth: 1.6, roughness: 1.1 });
  s.line(x, y + 14, x + w, y + 14, { strokeWidth: 1.2, roughness: 0.8 });
  for (const i of [0, 1, 2])
    s.circle(x + 9 + i * 10, y + 7, 5, { strokeWidth: 1.2, roughness: 0.5 });
}

function cloud(s, x, y, w, h, options) {
  const d = `M${x + w * 0.2} ${y + h}
    C${x - w * 0.06} ${y + h} ${x - w * 0.04} ${y + h * 0.48} ${x + w * 0.17} ${y + h * 0.5}
    C${x + w * 0.12} ${y + h * 0.08} ${x + w * 0.46} ${y - h * 0.06} ${x + w * 0.55} ${y + h * 0.24}
    C${x + w * 0.66} ${y + h * 0.02} ${x + w * 0.96} ${y + h * 0.12} ${x + w * 0.88} ${y + h * 0.48}
    C${x + w * 1.06} ${y + h * 0.56} ${x + w * 1.02} ${y + h} ${x + w * 0.8} ${y + h} Z`;
  s.path(d.replace(/\s+/g, " "), { strokeWidth: 2.4, ...options });
}

function box(s, x, y, w, h, title, note, options = {}) {
  const { fill, titleSize = 34 } = options;
  s.rect(x, y, w, h, { strokeWidth: 2.4, ...(fill ? xenonFill : {}) });
  s.text(title, x + w / 2, y + 48, { size: titleSize, bold: true, anchor: "middle" });
  if (note) s.text(note, x + w / 2, y + 84, { size: 23, anchor: "middle", color: SOFT });
}

export function system() {
  const s = new Sheet(1500, 1100);
  s.text("How localDot fits together", 60, 82, { size: 50, bold: true });
  s.text("(not to scale. nothing in here is to scale.)", 64, 124, { size: 24, color: SOFT });

  laptop(s, 74, 250);
  s.text("your browser", 170, 450, { size: 27, anchor: "middle" });
  phone(s, 133, 520);
  s.text("your phone", 170, 692, { size: 27, anchor: "middle" });
  s.text("(over your tailnet)", 170, 724, { size: 21, anchor: "middle", color: SOFT });

  s.rect(370, 230, 260, 470, { strokeWidth: 2.6 });
  s.text("localDot", 500, 286, { size: 38, bold: true, anchor: "middle" });
  s.text("the daemon,\non your Mac", 500, 326, { size: 23, anchor: "middle", color: SOFT });
  s.text(
    "chat & tasks\nlive picture\nrecordings\napprovals\nroutines\nweb search\nyour apps",
    400,
    432,
    {
      size: 26,
      leading: 1.32,
    },
  );
  for (let i = 0; i < 7; i++)
    s.circle(390, 424 + i * 34.3, 6, { strokeWidth: 1.5, roughness: 0.6 });

  s.arrow(
    [
      [290, 320],
      [330, 316],
      [362, 322],
    ],
    {},
  );
  s.arrow(
    [
      [222, 590],
      [300, 560],
      [362, 520],
    ],
    {},
  );
  s.text("watch, chat,\ntake over", 300, 472, { size: 21, color: SOFT, anchor: "middle" });

  s.rect(700, 190, 450, 600, { strokeWidth: 1.8, strokeLineDash: [14, 10], roughness: 1.2 });
  s.text("your isolated computer", 925, 236, { size: 30, bold: true, anchor: "middle" });
  s.text("containers. nothing of your Mac inside.", 925, 268, {
    size: 21,
    anchor: "middle",
    color: SOFT,
  });

  box(s, 728, 300, 186, 190, "desktop", "the screen\nyou watch");
  windowDoodle(s, 772, 420, 98, 54);
  box(s, 938, 300, 186, 190, "browser", "keeps your\nlogins");
  s.circle(1031, 448, 52, { strokeWidth: 1.6 });
  s.ellipse(1031, 448, 22, 52, { strokeWidth: 1.2, roughness: 0.8 });
  s.line(1005, 448, 1057, 448, { strokeWidth: 1.2, roughness: 0.8 });
  box(s, 728, 566, 186, 190, "brain", "the agent loop");
  dotFace(s, 821, 694, 62, xenonFill);
  box(s, 938, 566, 186, 190, "gate", "the only\nway out");
  s.line(990, 702, 1072, 702, { strokeWidth: 2.2 });
  s.line(990, 724, 1072, 724, { strokeWidth: 2.2 });
  for (const x of [1004, 1031, 1058]) s.line(x, 694, x, 732, { strokeWidth: 2.2 });

  s.arrow(
    [
      [632, 360],
      [680, 366],
      [722, 380],
    ],
    {},
  );
  s.text("picture", 668, 342, { size: 21, color: SOFT, anchor: "middle" });
  s.arrow(
    [
      [632, 640],
      [680, 640],
      [722, 650],
    ],
    {},
  );
  s.text("task", 668, 624, { size: 21, color: SOFT, anchor: "middle" });
  s.arrow(
    [
      [800, 562],
      [796, 530],
      [800, 496],
    ],
    { stroke: XENON, strokeWidth: 3 },
  );
  s.text("click, type, look", 814, 538, { size: 19, color: SOFT });
  s.arrow(
    [
      [1031, 496],
      [1036, 530],
      [1031, 562],
    ],
    {},
  );

  s.rect(1220, 546, 230, 210, { strokeWidth: 2.6, ...xenonFill });
  s.text("keyd", 1335, 604, { size: 40, bold: true, anchor: "middle" });
  s.text("holds your real\nkeys, on your Mac", 1335, 644, { size: 23, anchor: "middle" });
  s.arrow(
    [
      [1126, 660],
      [1170, 652],
      [1214, 650],
    ],
    {},
  );

  cloud(s, 1196, 188, 278, 168);
  s.text("providers, the web\n& your apps", 1335, 284, { size: 23, bold: true, anchor: "middle" });
  s.arrow(
    [
      [1335, 540],
      [1330, 450],
      [1335, 366],
    ],
    { stroke: XENON, strokeWidth: 3 },
  );
  s.text("real key goes\nin here, on\nthe way out", 1352, 420, { size: 21, color: SOFT });

  s.text("the brain only ever holds a stand-in.", 728, 846, { size: 25 });
  s.text("steal it and you've stolen a very boring string.", 728, 880, {
    size: 23,
    color: SOFT,
  });
  s.arrow(
    [
      [900, 818],
      [880, 796],
      [852, 766],
    ],
    { strokeWidth: 1.6 },
  );

  s.arrow(
    [
      [560, 706],
      [566, 880],
      [620, 948],
      [900, 954],
      [1200, 948],
      [1250, 900],
      [1258, 764],
    ],
    { stroke: XENON, strokeWidth: 2.6 },
  );
  s.text("web search & page reads: no sign-ins, no keys", 900, 936, {
    size: 21,
    color: SOFT,
    anchor: "middle",
  });
  s.rect(754, 982, 340, 88, { strokeWidth: 1.8, strokeLineDash: [12, 9], roughness: 1.2 });
  s.text("app cells", 924, 1019, { size: 28, bold: true, anchor: "middle" });
  s.text("one per app that runs as a program", 924, 1051, {
    size: 19,
    color: SOFT,
    anchor: "middle",
  });
  s.arrow(
    [
      [430, 706],
      [436, 940],
      [480, 1020],
      [600, 1026],
      [748, 1026],
    ],
    {},
  );
  s.text("your apps (MCP)", 600, 1012, { size: 21, color: SOFT, anchor: "middle" });
  s.arrow(
    [
      [1096, 1026],
      [1300, 1024],
      [1386, 990],
      [1398, 900],
      [1400, 764],
    ],
    {},
  );
  return { sheet: s, title: "How localDot fits together" };
}

function bubble(s, cx, cy) {
  s.ellipse(cx, cy - 6, 70, 46, { strokeWidth: 2 });
  s.polyline(
    [
      [cx - 16, cy + 12],
      [cx - 26, cy + 30],
      [cx - 2, cy + 15],
    ],
    { strokeWidth: 2 },
  );
  for (const dx of [-16, 0, 16])
    s.circle(cx + dx, cy - 6, 5, { fill: GRAPHITE, fillStyle: "solid", strokeWidth: 1 });
}

function checklist(s, cx, cy) {
  for (const i of [0, 1, 2]) {
    const y = cy - 24 + i * 24;
    s.rect(cx - 32, y - 8, 14, 14, { strokeWidth: 1.6, roughness: 0.8 });
    s.line(cx - 10, y, cx + 34, y, { strokeWidth: 1.8 });
  }
  s.tick(cx - 24, cy - 26, 16, { strokeWidth: 2 });
  s.tick(cx - 24, cy - 2, 16, { strokeWidth: 2 });
}

function cursor(s, cx, cy) {
  s.polygon(
    [
      [cx - 16, cy - 30],
      [cx - 16, cy + 18],
      [cx - 4, cy + 7],
      [cx + 6, cy + 28],
      [cx + 14, cy + 24],
      [cx + 4, cy + 4],
      [cx + 20, cy + 3],
    ],
    { strokeWidth: 2.2, fill: GRAPHITE, fillStyle: "hachure", hachureGap: 4 },
  );
}

function eye(s, cx, cy) {
  s.path(
    `M${cx - 38} ${cy} Q${cx} ${cy - 34} ${cx + 38} ${cy} Q${cx} ${cy + 34} ${cx - 38} ${cy}Z`,
    {
      strokeWidth: 2.2,
    },
  );
  s.circle(cx, cy, 26, { strokeWidth: 2 });
  s.circle(cx, cy, 10, { fill: GRAPHITE, fillStyle: "solid", strokeWidth: 1 });
}

function film(s, cx, cy) {
  s.rect(cx - 36, cy - 26, 72, 52, { strokeWidth: 2.2 });
  for (const x of [-26, -12, 2, 16])
    for (const y of [-21, 17]) s.rect(cx + x, cy + y, 7, 5, { strokeWidth: 1, roughness: 0.4 });
  s.polygon(
    [
      [cx - 8, cy - 11],
      [cx - 8, cy + 11],
      [cx + 12, cy],
    ],
    { strokeWidth: 2, fill: GRAPHITE, fillStyle: "solid" },
  );
}

export function taskLoop() {
  const s = new Sheet(1500, 700);
  s.text("One task, start to finish", 60, 82, { size: 50, bold: true });
  const y = 330;
  const steps = [
    ["ask", "you type what\nyou want", bubble],
    ["plan", "dot jots down\na short plan", checklist],
    ["act", "click, type, drag,\nrun some code", cursor],
    ["look", "a fresh look at\nthe screen", eye],
    [
      "narrate",
      "one line on what\nit's doing and why",
      (sh, cx, cy) => dotFace(sh, cx, cy + 4, 74),
    ],
    ["replay", "every step is\nrecorded", film],
  ];
  const x0 = 150;
  const gap = 240;
  steps.forEach(([name, note, doodle], i) => {
    const cx = x0 + i * gap;
    const loop = i >= 2 && i <= 4;
    s.circle(cx, y, 150, { strokeWidth: 2.6, ...(loop ? xenonFill : {}) });
    doodle(s, cx, y);
    s.text(name, cx, y + 124, { size: 36, bold: true, anchor: "middle" });
    s.text(note, cx, y + 162, { size: 23, anchor: "middle", color: SOFT });
    if (i < steps.length - 1)
      s.arrow(
        [
          [cx + 82, y + 4],
          [cx + gap / 2, y - 8],
          [cx + gap - 84, y + 2],
        ],
        loop && i < 4 ? { stroke: XENON, strokeWidth: 3 } : {},
      );
  });
  const act = x0 + 2 * gap;
  const narrate = x0 + 4 * gap;
  s.arrow(
    [
      [narrate - 10, y - 86],
      [narrate - 120, y - 168],
      [act + 120, y - 168],
      [act + 6, y - 88],
    ],
    { stroke: XENON, strokeWidth: 3 },
  );
  s.text("round and round until it's done", (act + narrate) / 2, y - 186, {
    size: 26,
    anchor: "middle",
  });

  s.arrow(
    [
      [act - 30, y + 210],
      [act - 70, y + 250],
      [act - 120, y + 262],
    ],
    { strokeWidth: 1.8, strokeLineDash: [8, 8] },
  );
  s.text(
    'needs you? it asks right in the chat:\nan OK, a password, or "take over for a sec".',
    act - 130,
    y + 260,
    { size: 23, anchor: "end" },
  );
  s.text("you can scrub it later,\nor export it as a video", x0 + 5 * gap, y + 232, {
    size: 21,
    anchor: "middle",
    color: SOFT,
  });
  return { sheet: s, title: "One task, start to finish" };
}

function screen(s, cx, cy) {
  windowDoodle(s, cx - 58, cy - 40, 116, 76);
  cursor(s, cx + 30, cy + 22);
}

function globe(s, cx, cy) {
  s.circle(cx, cy, 86, { strokeWidth: 2 });
  s.ellipse(cx, cy, 38, 86, { strokeWidth: 1.4, roughness: 0.8 });
  s.line(cx - 42, cy, cx + 42, cy, { strokeWidth: 1.4, roughness: 0.8 });
  s.path(`M${cx - 36} ${cy - 22} Q${cx} ${cy - 30} ${cx + 36} ${cy - 22}`, { strokeWidth: 1.2 });
  s.path(`M${cx - 36} ${cy + 22} Q${cx} ${cy + 30} ${cx + 36} ${cy + 22}`, { strokeWidth: 1.2 });
}

function terminal(s, cx, cy) {
  s.rounded(cx - 60, cy - 42, 120, 84, 8, { strokeWidth: 2.2 });
  s.polyline(
    [
      [cx - 40, cy - 16],
      [cx - 22, cy - 2],
      [cx - 40, cy + 12],
    ],
    { strokeWidth: 2.6 },
  );
  s.line(cx - 12, cy + 16, cx + 22, cy + 16, { strokeWidth: 2.6, stroke: XENON });
}

function page(s, x, y, w, h, options = {}) {
  const fold = 18;
  s.polygon(
    [
      [x, y],
      [x + w - fold, y],
      [x + w, y + fold],
      [x + w, y + h],
      [x, y + h],
    ],
    { strokeWidth: 2.2, ...options },
  );
  s.polyline(
    [
      [x + w - fold, y],
      [x + w - fold, y + fold],
      [x + w, y + fold],
    ],
    { strokeWidth: 1.6 },
  );
}

function files(s, cx, cy) {
  page(s, cx - 62, cy - 30, 64, 80, { fill: XENON, fillWeight: 1.4, hachureGap: 8 });
  page(s, cx - 18, cy - 46, 70, 88, { fill: PAPER, fillStyle: "solid" });
  for (const dy of [-14, 2, 18]) s.line(cx - 6, cy + dy, cx + 38, cy + dy, { strokeWidth: 1.6 });
}

function magnifier(s, cx, cy) {
  s.circle(cx - 10, cy - 10, 66, { strokeWidth: 2.4 });
  s.path(`M${cx - 30} ${cy - 18} Q${cx - 24} ${cy - 32} ${cx - 10} ${cy - 34}`, {
    strokeWidth: 1.6,
    stroke: XENON,
  });
  s.line(cx + 14, cy + 14, cx + 46, cy + 44, { strokeWidth: 5 });
}

function sources(s, cx, cy) {
  page(s, cx - 56, cy - 44, 76, 92);
  s.text("[1]", cx - 46, cy - 12, { size: 20, bold: true, color: XENON });
  s.line(cx - 16, cy - 18, cx + 8, cy - 18, { strokeWidth: 1.4 });
  s.text("[2]", cx - 46, cy + 18, { size: 20, bold: true, color: XENON });
  s.line(cx - 16, cy + 12, cx + 8, cy + 12, { strokeWidth: 1.4 });
  s.circle(cx + 40, cy + 2, 46, { strokeWidth: 2 });
  s.line(cx + 56, cy + 18, cx + 72, cy + 36, { strokeWidth: 4 });
}

function microphone(s, cx, cy) {
  s.rounded(cx - 18, cy - 48, 36, 62, 18, { strokeWidth: 2.4, ...xenonFill });
  s.path(
    `M${cx - 34} ${cy - 6} Q${cx - 34} ${cy + 30} ${cx} ${cy + 30} Q${cx + 34} ${cy + 30} ${cx + 34} ${cy - 6}`,
    { strokeWidth: 2.2 },
  );
  s.line(cx, cy + 30, cx, cy + 48, { strokeWidth: 2.2 });
  s.line(cx - 18, cy + 48, cx + 18, cy + 48, { strokeWidth: 2.2 });
}

function plug(s, cx, cy) {
  s.rounded(cx - 30, cy - 22, 52, 50, 8, { strokeWidth: 2.4 });
  s.line(cx + 22, cy - 8, cx + 46, cy - 8, { strokeWidth: 3 });
  s.line(cx + 22, cy + 14, cx + 46, cy + 14, { strokeWidth: 3 });
  s.path(
    `M${cx - 30} ${cy + 3} C${cx - 62} ${cy + 3} ${cx - 48} ${cy + 46} ${cx - 76} ${cy + 44}`,
    { strokeWidth: 2.2, stroke: XENON },
  );
}

function clock(s, cx, cy) {
  s.circle(cx, cy, 92, { strokeWidth: 2.4 });
  for (const a of [0, 90, 180, 270]) {
    const r = (a * Math.PI) / 180;
    const [c, n] = [Math.cos(r), Math.sin(r)];
    s.line(cx + 36 * c, cy + 36 * n, cx + 42 * c, cy + 42 * n, { strokeWidth: 2 });
  }
  s.line(cx, cy, cx, cy - 30, { strokeWidth: 2.6 });
  s.line(cx, cy, cx + 22, cy + 8, { strokeWidth: 2.6, stroke: XENON });
}

function notebook(s, cx, cy) {
  s.rect(cx - 40, cy - 46, 84, 94, { strokeWidth: 2.4 });
  for (const dy of [-30, -10, 10, 30]) s.circle(cx - 40, cy + dy, 10, { strokeWidth: 1.4 });
  for (const dy of [-22, -2, 18]) s.line(cx - 24, cy + dy, cx + 30, cy + dy, { strokeWidth: 1.6 });
  s.tick(cx + 22, cy + 34, 18, { strokeWidth: 2.2, stroke: XENON });
}

function asks(s, cx, cy) {
  s.ellipse(cx - 18, cy - 4, 82, 58, { strokeWidth: 2 });
  s.text("?", cx - 18, cy + 10, { size: 40, bold: true, anchor: "middle" });
  s.polyline(
    [
      [cx - 30, cy + 22],
      [cx - 40, cy + 42],
      [cx - 14, cy + 25],
    ],
    { strokeWidth: 2 },
  );
  s.rounded(cx + 34, cy + 4, 56, 38, 12, { strokeWidth: 2.2, ...xenonFill });
  s.tick(cx + 62, cy + 22, 18, { strokeWidth: 2.4 });
}

export function capabilities() {
  const s = new Sheet(1500, 1060);
  s.text("What dot can do", 60, 82, { size: 50, bold: true });
  s.text("(all of it on its own computer, all of it where you can watch.)", 64, 124, {
    size: 24,
    color: SOFT,
  });
  const cells = [
    ["the screen", "clicks, types, drags\nand looks again", screen],
    ["web browser", "keeps your sign-ins\nacross tasks", globe],
    ["terminal", "runs code and\ncommands", terminal],
    ["files", "makes them, changes\nthem, hands them over", files],
    ["web search", "web, images, news,\nand reads public pages", magnifier],
    ["deep research", "numbered sources,\na cited report", sources],
    ["voice", "talk instead of typing.\nit can read replies aloud", microphone],
    ["your apps", "connectors (MCP)\nas tools", plug],
    ["routines", "the same task,\non a schedule", clock],
    ["memory", "two Markdown files\nyou can edit", notebook],
    ["asks you", "before it acts as you.\ntake over any time", asks],
  ];
  const w = 330;
  const h = 268;
  const gap = 26;
  const x0 = 64;
  const y0 = 170;
  const at = (i) => [x0 + (i % 4) * (w + gap), y0 + Math.floor(i / 4) * (h + gap)];
  cells.forEach(([name, note, doodle], i) => {
    const [x, y] = at(i);
    s.rect(x, y, w, h, { strokeWidth: 2, roughness: 1.2 });
    doodle(s, x + w / 2, y + 86);
    s.text(name, x + w / 2, y + 180, { size: 32, bold: true, anchor: "middle" });
    s.text(note, x + w / 2, y + 214, { size: 22, anchor: "middle", color: SOFT, leading: 1.3 });
  });
  const [x, y] = at(cells.length);
  dotFace(s, x + w / 2, y + 96, 104, xenonFill);
  s.text("that's dot.", x + w / 2, y + 196, { size: 30, bold: true, anchor: "middle" });
  s.text("it does the work.\nyou keep the say.", x + w / 2, y + 228, {
    size: 22,
    anchor: "middle",
    color: SOFT,
  });
  return { sheet: s, title: "What dot can do" };
}

export function safety() {
  const s = new Sheet(1760, 960);
  s.text("What stands between dot and the world", 60, 82, { size: 50, bold: true });
  s.text("(most things sail through. a few really shouldn't.)", 64, 124, {
    size: 24,
    color: SOFT,
  });

  dotFace(s, 196, 300, 104, xenonFill);
  s.text("dot wants to…", 196, 396, { size: 30, bold: true, anchor: "middle" });

  const walls = [
    ["hard\nchecks", "pay, post as you,\npasswords, uploads"],
    ["purpose\ncheck", "optional. private\ndata going astray?"],
    ["approvals", "a yes can cover\nthe task, the site\nor always"],
    ["isolated\ncomputer", "it only touches\nits own machine"],
    ["network\ngate", "no LAN, router\nor cloud metadata"],
    ["stand-in\nkeys", "real key added\nat the edge"],
  ];
  const wx = (i) => 540 + i * 190;
  const top = 470;
  const bottom = 900;
  walls.forEach(([name, note], i) => {
    const x = wx(i);
    s.rect(x - 15, top, 30, bottom - top, {
      strokeWidth: 2.2,
      fill: GRAPHITE,
      fillWeight: 1,
      hachureGap: 9,
      hachureAngle: 60,
    });
    const lines = name.split("\n").length;
    const y = lines === 1 ? 236 : 200;
    s.text(name, x, y, { size: 29, bold: true, anchor: "middle", leading: 1.15 });
    s.text(note, x, 290, { size: 21, anchor: "middle", color: SOFT, leading: 1.3 });
    s.line(x, 404, x, top - 10, { strokeWidth: 1.2, strokeLineDash: [5, 7] });
  });

  const lanes = [
    { y: 540, label: "search, read a page,\nclick, type" },
    { y: 625, label: "send an email\nas you", stop: 0, mark: "?", note: "asks you" },
    { y: 710, label: "post your notes to\nsome random site", stop: 1, mark: "?", note: "asks you" },
    { y: 795, label: "poke the router\nat 192.168.1.1", stop: 4, mark: "x", note: "blocked" },
    { y: 870, label: "smuggle out\nthe API key", stop: 5, mark: "x", note: "it's a stand-in" },
  ];
  cloud(s, 1606, 486, 140, 100);
  s.text("the\ninternet", 1676, 540, { size: 23, bold: true, anchor: "middle" });
  s.tick(1622, 626, 24, { stroke: XENON });
  s.text("just runs", 1646, 634, { size: 22 });
  for (const lane of lanes) {
    s.text(lane.label, 336, lane.y - 8, { size: 25, anchor: "end", leading: 1.15 });
    const pass = lane.stop === undefined;
    const end = pass ? 1606 : wx(lane.stop) - 26;
    s.arrow(
      [
        [354, lane.y],
        [(354 + end) / 2, lane.y - 5],
        [end, lane.y + 2],
      ],
      pass ? { stroke: XENON, strokeWidth: 3.2 } : { strokeWidth: 2.4 },
    );
    if (pass) continue;
    const right = wx(lane.stop) - 30;
    if (lane.mark === "x") s.cross(right - 12, lane.y - 30, 18);
    else s.text("?", right - 12, lane.y - 14, { size: 36, bold: true, anchor: "middle" });
    if (lane.stop === walls.length - 1)
      s.text(lane.note, wx(lane.stop) + 34, lane.y + 8, { size: 22, color: SOFT });
    else s.text(lane.note, right - 32, lane.y - 18, { size: 22, anchor: "end", color: SOFT });
  }
  return { sheet: s, title: "What stands between dot and the world" };
}
