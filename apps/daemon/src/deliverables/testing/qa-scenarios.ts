import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { type ReviseLink, ULID_PATTERN, ulid } from "@localdot/protocol";
import type { Hono } from "hono";
import sharp from "sharp";
import { OutputStore } from "../../agent/output-store.ts";
import type { AgentSession } from "../../agent/session.ts";
import type { EventLog } from "../../event-log.ts";
import type { FrameStore } from "../../gateway/frames.ts";
import { type Converter, Previews } from "../previews.ts";
import type { DeliverablesDeps, ReviseDeps } from "../routes.ts";
import { TaskScanner } from "../task-scan.ts";
import { pdfOf, wavOf, xlsxOf, zipOf } from "./sample-files.ts";

export interface DeliverablesFixture {
  home: string;
  assets: string;
  log: EventLog;
  frames: FrameStore;
  effects: string[];
  session(): AgentSession | undefined;
  // Starts a task linked to the version it revises, as the runner does.
  start?(task: string, revises: ReviseLink): Promise<{ id: string }>;
}
// A page image stands in for LibreOffice: the fixture has no real computer.
const page = sharp({ create: { width: 1240, height: 1754, channels: 3, background: "#ffffff" } })
  .composite([
    {
      input: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1240" height="1754"><rect x="120" y="140" width="1000" height="40" fill="#222"/><rect x="120" y="240" width="900" height="20" fill="#888"/><rect x="120" y="290" width="940" height="20" fill="#888"/><rect x="120" y="340" width="700" height="20" fill="#888"/></svg>',
      ),
    },
  ])
  .png()
  .toBuffer();

export function deliverablesDeps(f: DeliverablesFixture): Omit<DeliverablesDeps, "port"> {
  const converter: Converter = {
    convert: async (name) => {
      f.effects.push(`convert:${name}`);
      return page;
    },
  };
  mkdirSync(join(f.home, "mac-downloads"), { recursive: true });
  const downloads = realpathSync(join(f.home, "mac-downloads"));
  return {
    home: f.home,
    eventLog: f.log,
    scanner: new TaskScanner(f.log),
    frames: f.frames,
    previews: new Previews(f.home, converter),
    opener: {
      downloads,
      platform: "darwin",
      quarantine: async () => {},
      launch: async (path) => void f.effects.push(`open:${path.slice(downloads.length + 1)}`),
    },
    ...(f.start ? { revise: fakeRevise(f, f.start) } : {}),
  };
}
// The copy into the computer is recorded, not made: the fixture has no real computer.
function fakeRevise(
  f: DeliverablesFixture,
  start: NonNullable<DeliverablesFixture["start"]>,
): ReviseDeps {
  return {
    start: (_cellId, task, _signal, opts) => start(task, opts.revises),
    access: () => ({
      tools: {
        putFile: async (path, source) => {
          await new Response(source).arrayBuffer();
          f.effects.push(`revise:${path}`);
          return `~/${path}`;
        },
      },
      signal: new AbortController().signal,
      check: () => {},
      release: () => {},
    }),
    redactUserText: (text) => text,
  };
}

// /__qa/files hands over one file of every kind; /__qa/revise answers a follow-up with v2 of
// totals.csv; /__qa/previews hands over real files of every kind the full preview shows, the page
// and the SVG carrying scripts that would call /__qa/canary if they ever ran. ?probe=<port> also
// points the page's connection hints and links at that port, for a listener counting connections.
export function deliverableScenarios(app: Hono, f: DeliverablesFixture): void {
  const outputs = new OutputStore(f.home);
  const observe = (s: AgentSession, step: string, n: number) => {
    const file = join(f.assets, `frame-${n}.webp`);
    if (!existsSync(file)) return;
    const frameId = ulid();
    f.frames.save(s.id, frameId, readFileSync(file));
    s.append("observe", { frameId, width: 2560, height: 1600 }, step);
  };
  const hand = (s: AgentSession, summary: string, files: Record<string, Buffer | string>) => {
    const saved = Object.entries(files).map(([name, data]) => {
      const out = outputs.saveBytes(
        s.id,
        name,
        typeof data === "string" ? Buffer.from(data) : data,
      );
      return { name, path: `Documents/${name}`, bytes: out.bytes, version: out.version };
    });
    s.append("task.result", { summary, files: saved });
    s.setStatus("idle");
    s.append("agent.state", { state: "idle" });
  };
  app.post("/__qa/files", async (c) => {
    const s = f.session();
    if (!s) return c.text("no session", 409);
    // ?recording=<a seeded task> lends the live task that task's recording, so it can be exported.
    const lent = c.req.query("recording") ?? "";
    const recording = join(f.home, "sessions", lent, "recording");
    if (ULID_PATTERN.test(lent) && existsSync(recording))
      cpSync(recording, join(f.home, "sessions", s.id, "recording"), { recursive: true });
    const steps = [ulid(), ulid(), ulid()];
    observe(s, steps[0] as string, 1);
    s.append(
      "file.change",
      { path: "Documents/totals.csv", op: "create", patch: "+Month,Net\n+Dec,12000" },
      steps[1],
    );
    observe(s, steps[1] as string, 2);
    observe(s, steps[2] as string, 3);
    s.append("step.verify", { status: "success", evidence: "opens, 4 sheets" }, steps[2]);
    const chart = await sharp({
      create: { width: 1600, height: 1000, channels: 3, background: "#3a7bd5" },
    })
      .png()
      .toBuffer();
    hand(s, "Here are the sample files.", {
      "chart.png": chart,
      "totals.csv": "Month,Net\nNov,11800\nDec,12000\n",
      "notes.md": "# Sample notes\n\n- Totals checked\n- Chart attached\n",
      "report.ods": "sample spreadsheet bytes",
      "brief.docx": "sample document bytes",
      "scan.pdf": "%PDF-1.7 sample",
      "diagram.svg": '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      "page.html": "<script>alert(1)</script>",
    });
    return c.json({ ok: true });
  });
  app.get("/__qa/canary", (c) => {
    f.effects.push(`canary:${c.req.query("from") ?? ""}`);
    return c.body(null, 204);
  });
  app.post("/__qa/previews", async (c) => {
    const s = f.session();
    if (!s) return c.text("no session", 409);
    const video = join(f.assets, "clip.mp4");
    const probe = Number(c.req.query("probe"));
    hand(s, "Here is the quarter's report, with its data, chart and notes.", {
      "report.pdf": samplePdf(),
      "chart.png": await sampleChart(),
      "summary.html": samplePage(Number.isInteger(probe) && probe > 0 ? probe : undefined),
      "summary.css": SAMPLE_STYLES,
      "diagram.svg": SAMPLE_SVG,
      "orders.xlsx": sampleWorkbook(),
      "notes.md": SAMPLE_NOTES,
      "clean.py": SAMPLE_CODE,
      "totals.json": SAMPLE_JSON,
      "run.log": sampleLog(),
      ...(existsSync(video) ? { "walkthrough.mp4": readFileSync(video) } : {}),
      "voice-note.wav": wavOf(2),
      "archive.zip": zipOf({ "readme.txt": "The quarter's files." }),
    });
    return c.json({ ok: true });
  });
  app.post("/__qa/revise", (c) => {
    const s = f.session();
    if (!s) return c.text("no session", 409);
    hand(s, "Added a total row.", {
      "totals.csv": "Month,Net\nNov,11800\nDec,12000\nTotal,23800\n",
    });
    return c.json({ ok: true });
  });
}

const REGIONS = ["North", "South", "East", "West"];
const ITEMS = ["Lamp", "Desk", "Chair", "Shelf", "Rug"];
function sampleWorkbook(): Buffer {
  const orders: (string | number | Date)[][] = [["Order", "Date", "Region", "Item", "Qty", "Net"]];
  for (let i = 0; i < 1240; i++)
    orders.push([
      `Q3-${String(1001 + i)}`,
      new Date(Date.UTC(2026, 6, 1 + (i % 92))),
      REGIONS[i % 4] as string,
      ITEMS[(i * 7) % 5] as string,
      1 + ((i * 13) % 9),
      Math.round((40 + ((i * 37) % 260)) * 100) / 100,
    ]);
  const summary = [
    ["Region", "Orders", "Net"],
    ...REGIONS.map((r, i) => [r, 310, 41_250 + i * 3_175]),
  ];
  return xlsxOf([
    { name: "Orders", rows: orders },
    { name: "Summary", rows: summary },
  ]);
}

function samplePdf(): Buffer {
  const body = [
    "Revenue grew in every region this quarter, led by the North.",
    "Returns fell to 2.1 per cent of orders, the lowest this year.",
    "The new desk range sold out twice and is back in stock.",
    "",
    "Next quarter: open the West warehouse and trial weekend delivery.",
  ];
  return pdfOf([
    { title: "Quarterly report", lines: body, bars: [120, 180, 150, 210, 260] },
    { title: "Regions", lines: REGIONS.map((r, i) => `${r}: ${310 + i * 12} orders`) },
    { title: "Notes", lines: ["Figures are net of returns.", "Prepared by dot."] },
  ]);
}

async function sampleChart(): Promise<Buffer> {
  const bars = [0.42, 0.58, 0.51, 0.74, 0.88, 0.67];
  const rects = bars
    .map(
      (h, i) =>
        `<rect x="${110 + i * 170}" y="${640 - h * 520}" width="110" height="${h * 520}" rx="14" fill="${i === 4 ? "#3fb5de" : "#8a94a6"}"/>`,
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="750"><rect x="40" y="40" width="1120" height="670" rx="36" fill="#ffffff" fill-opacity="0.92"/><path d="M90 640H1110" stroke="#c9ced6" stroke-width="3"/>${rects}<text x="110" y="110" font-family="Helvetica" font-size="40" font-weight="700" fill="#1d2330">Net by month</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function sampleLog(): string {
  const lines: string[] = [];
  for (let i = 0; i < 2400; i++) {
    const t = new Date(Date.UTC(2026, 9, 9, 9, 0, i)).toISOString();
    lines.push(
      i % 97 === 0
        ? `${t} WARN  sync: retrying upload ${i} (timeout after 30s)`
        : `${t} INFO  sync: copied order batch ${i} (${40 + (i % 60)} rows)`,
    );
  }
  lines.push(
    `${new Date(Date.UTC(2026, 9, 9, 9, 40)).toISOString()} INFO  sync: done, 2400 batches`,
  );
  return `${lines.join("\n")}\n`;
}

// Each way a page could reach a server with no script: hints to connect, fetch or render ahead, the
// same hints in a frame's srcdoc, a link that opens a window, and one that reports the click.
function probeTags(port: number): { head: string; body: string } {
  const at = `http://127.0.0.1:${port}`;
  const framed = `<iframe srcdoc="<link rel=preconnect href='${at}/srcdoc'>" title="srcdoc"></iframe>
<svg width="1" height="1"><foreignObject width="1" height="1"><iframe srcdoc="&lt;link rel=preconnect href=&quot;${at}/escaped&quot;&gt;"></iframe></foreignObject></svg>`;
  return {
    head: [
      `<link rel="preconnect" href="${at}">`,
      `<link rel="dns-prefetch" href="${at}">`,
      `<link rel="prefetch" href="${at}/prefetch">`,
      `<link rel="preload" as="image" href="${at}/preload.png">`,
      `<link rel="modulepreload" href="${at}/module.js">`,
      `<link rel="prerender" href="${at}/prerender">`,
      `<link rel="stylesheet" href="${at}/remote.css">`,
    ].join("\n"),
    body: `<p class="links"><a href="${at}/window" target="_blank">New window</a> · <a href="${at}/page" ping="${at}/ping">Tracked link</a></p>\n${framed}`,
  };
}

function samplePage(probe?: number): string {
  const tags = probe === undefined ? { head: "", body: "" } : probeTags(probe);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="1;url=/__qa/canary?from=refresh">
<title>Quarter in brief</title>
<link rel="stylesheet" href="summary.css">
<link rel="stylesheet" href="https://fonts.example.test/brand.css">
<script>fetch("/__qa/canary?from=inline")</script>
${tags.head}
</head>
<body>
<header>
  <p class="eyebrow">Q3 2026</p>
  <h1>Quarter in brief</h1>
  <p class="lede">Revenue grew in every region, returns fell, and the desk range sold out twice.</p>
</header>
<section class="stats">
  <div><span>Net</span><strong>£168,900</strong></div>
  <div><span>Orders</span><strong>1,240</strong></div>
  <div><span>Returns</span><strong>2.1%</strong></div>
</section>
<figure>
  <img src="chart.png" alt="Net by month">
  <figcaption>Net by month, July to September.</figcaption>
</figure>
<img class="hero" src="https://images.example.test/hero.jpg" alt="">
<img class="probe" src="missing.png" alt="" onerror="fetch('/__qa/canary?from=onerror')">
<p class="links"><a href="javascript:fetch('/__qa/canary?from=javascript')">Open the dashboard</a> · <a href="https://example.test/report">Full report</a></p>
<form action="https://example.test/submit"><button id="send">Send feedback</button></form>
<iframe src="https://example.test/embed" title="embed"></iframe>
${tags.body}
</body>
</html>
`;
}

const SAMPLE_STYLES = `body { margin: 0; padding: 48px 56px; font: 16px/1.5 -apple-system, "Helvetica Neue", sans-serif; color: #1d2330; background: #f6f7f9; }
header { max-width: 640px; }
.eyebrow { margin: 0; color: #3fb5de; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; font-size: 13px; }
h1 { margin: 6px 0 8px; font-size: 34px; letter-spacing: -.02em; }
.lede { margin: 0; color: #5b6475; font-size: 18px; }
.stats { display: flex; gap: 16px; margin: 32px 0; }
.stats div { flex: 1; padding: 18px 20px; border-radius: 14px; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.06); }
.stats span { display: block; color: #7a8394; font-size: 13px; }
.stats strong { font-size: 26px; letter-spacing: -.02em; }
figure { margin: 0; padding: 20px; border-radius: 16px; background: #fff; }
figure img { display: block; width: 100%; max-width: 720px; }
figcaption { margin-top: 10px; color: #7a8394; font-size: 13px; }
.hero, .probe { width: 1px; height: 1px; }
.links { margin-top: 24px; color: #7a8394; }
form { margin-top: 8px; }
iframe { display: none; }
`;

const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540" onload="fetch('/__qa/canary?from=svg-onload')">
<script>fetch("/__qa/canary?from=svg-script")</script>
<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#3fb5de"/><stop offset="1" stop-color="#6a5acd"/></linearGradient></defs>
<g font-family="Helvetica, Arial, sans-serif" font-size="22" text-anchor="middle">
<rect x="60" y="200" width="220" height="120" rx="22" fill="#ffffff" stroke="#c9ced6" stroke-width="2"/>
<text x="170" y="268" fill="#1d2330">Orders</text>
<rect x="370" y="200" width="220" height="120" rx="22" fill="url(#g)"/>
<text x="480" y="268" fill="#ffffff">Clean up</text>
<rect x="680" y="200" width="220" height="120" rx="22" fill="#ffffff" stroke="#c9ced6" stroke-width="2"/>
<text x="790" y="268" fill="#1d2330">Report</text>
<path d="M285 260H362M595 260H672" stroke="#8a94a6" stroke-width="4" stroke-linecap="round"/>
<path d="M352 250l12 10-12 10M662 250l12 10-12 10" fill="none" stroke="#8a94a6" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
</g>
</svg>
`;

const SAMPLE_NOTES = `# Quarter notes

The quarter closed **ahead of plan**. Three things stood out:

1. Every region grew, the North most of all.
2. Returns fell to *2.1 per cent*.
3. The desk range sold out twice.

## Next steps

- [x] Reconcile the order export
- [x] Share the chart with the team
- [ ] Open the West warehouse

| Region | Orders | Net |
| --- | ---: | ---: |
| North | 310 | £41,250 |
| South | 310 | £44,425 |

\`\`\`sql
select region, sum(net) from orders group by region;
\`\`\`

> Figures are net of returns.
`;

const SAMPLE_CODE = `"""Clean the quarter's order export before the report is built."""
import csv
from datetime import date
from pathlib import Path

REGIONS = {"N": "North", "S": "South", "E": "East", "W": "West"}


def clean(row: dict) -> dict | None:
    # Orders without a quantity are drafts, never sales.
    if not row.get("qty"):
        return None
    return {
        "order": row["order"].strip(),
        "date": date.fromisoformat(row["date"]),
        "region": REGIONS.get(row["region"], "Other"),
        "qty": int(row["qty"]),
        "net": round(float(row["net"]) * 1.0, 2),
    }


def main(path: Path) -> int:
    kept = 0
    with path.open() as source:
        for row in csv.DictReader(source):
            if clean(row) is not None:
                kept += 1
    print(f"kept {kept} orders")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(Path("orders.csv")))
`;

const SAMPLE_JSON = JSON.stringify(
  {
    quarter: "2026-Q3",
    currency: "GBP",
    totals: { net: 168900, orders: 1240, returns: 0.021 },
    regions: REGIONS.map((name, i) => ({
      name,
      orders: 310,
      net: 41250 + i * 3175,
      growth: 0.04 + i / 100,
    })),
    checked: true,
    notes: null,
  },
  null,
  2,
);
