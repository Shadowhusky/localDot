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
// totals.csv.
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
  app.post("/__qa/revise", (c) => {
    const s = f.session();
    if (!s) return c.text("no session", 409);
    hand(s, "Added a total row.", {
      "totals.csv": "Month,Net\nNov,11800\nDec,12000\nTotal,23800\n",
    });
    return c.json({ ok: true });
  });
}
