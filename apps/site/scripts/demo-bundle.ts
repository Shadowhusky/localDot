// Builds a website demo from a finished localDot task: its events, re-timed to a Theatre video.
// node scripts/demo-bundle.ts qa/live/bundles.json [demo-id]
// The configuration names reviewed sessions and their cuts; it stays in ignored qa/.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DemoResult,
  type DemoTimeline,
  previewTicket,
  prune,
  type Segment,
} from "../src/hero/demo.ts";

interface DemoConfig {
  id: string;
  sessionId: string;
  title: string;
  prompt: string;
  persona: DemoTimeline["persona"];
  modelLabel: string;
  reviewed: boolean;
  // Session seconds and the speed each plays at.
  cuts: { from: number; to: number; speed: number }[];
  // "export": each cut is rendered by the daemon's own export, as the app's Export makes videos.
  // "raw": the recording is cut here, for quick drafts.
  video?: "export" | "raw";
  // Session seconds after which nothing is kept, for a task that went wrong after it delivered.
  until?: number;
  // Frames of the finished video caught mid-glitch or mid-load, each shown as the frame before it
  // (the first frame as the one after).
  freeze?: number[];
  // Exports with the app's other looks, for the story's export chapter: session seconds and speed.
  cards?: {
    name: string;
    from: number;
    to: number;
    speed: number;
    captions?: boolean;
    dot?: "under" | "over";
  }[];
  results?: DemoResult[];
}
interface Config {
  origin: string;
  tokenFile: string;
  demos: DemoConfig[];
}

const [configPath, only] = process.argv.slice(2);
if (!configPath) throw new Error("Pass the private bundle configuration.");
const config: Config = JSON.parse(readFileSync(configPath, "utf8"));
const origin = new URL(config.origin);
if (!["127.0.0.1", "localhost"].includes(origin.hostname)) throw new Error("Use the local daemon.");
const token = readFileSync(config.tokenFile, "utf8").trim();
const headers = { Authorization: `Bearer ${token}`, Origin: origin.origin };
const OUT = new URL("../public/demos/", import.meta.url).pathname;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ffmpeg = (args: string[]) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args]);

// The Theatre's filter graph at `width`, its output labelled [out].
function theatreFilter(width: number, freeze: readonly number[] = []): string {
  let graph = `[0:v]fps=30,scale=${width}:-2:flags=lanczos[v0]`;
  for (const [i, n] of freeze.entries())
    graph += `;[v${i}]split[a${i}][b${i}];[a${i}][b${i}]freezeframes=first=${n}:last=${n}:replace=${n ? n - 1 : 1}[v${i + 1}]`;
  return `${graph};[v${freeze.length}]null[out]`;
}

async function get(path: string, init: RequestInit = {}): Promise<Response> {
  let response: Response | undefined;
  // The daemon can drop a connection while it is busy; a request is tried three times.
  for (let attempt = 1; !response; attempt++) {
    try {
      response = await fetch(`${origin.origin}${path}`, {
        ...init,
        headers: { ...headers, ...(init.body ? { "Content-Type": "application/json" } : {}) },
      });
    } catch (error) {
      if (attempt === 3) throw error;
      await wait(2000 * attempt);
    }
  }
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response;
}

// One cut of the Theatre, made by the daemon's export with dot's pointer, clicks and typing drawn
// over the screen. The job is removed once its file is saved, so the app's list stays as it was.
async function exported(
  sessionId: string,
  segment: Segment,
  file: string,
  look: { captions?: boolean; dot?: "under" | "over"; size?: { w: number; h: number } } = {},
): Promise<void> {
  const request = {
    sessionId,
    fromMs: segment.from,
    toMs: segment.to,
    speed: segment.speed,
    skipIdle: false,
    captions: look.captions ?? false,
    overlays: true,
    ...(look.dot ? { dot: look.dot } : {}),
    size: look.size ?? { w: 1920, h: 1200 },
    fps: 30,
    quality: "high",
    format: "mp4",
  };
  const job = (await (
    await get("/api/exports", {
      method: "POST",
      body: JSON.stringify({ request, screen: "desktop" }),
    })
  ).json()) as { id: string };
  try {
    for (;;) {
      await wait(2000);
      const state = (await (await get("/api/exports")).json()) as {
        exports: { id: string; phase: string; error: string | null; done: number; total: number }[];
      };
      const now = state.exports.find((e) => e.id === job.id);
      if (!now) throw new Error("The export disappeared.");
      if (now.phase === "failed") throw new Error(`Export failed: ${now.error}`);
      if (now.phase === "done") break;
    }
    writeFileSync(
      file,
      Buffer.from(await (await get(`/api/exports/${job.id}/file`)).arrayBuffer()),
    );
  } finally {
    await get(`/api/exports/${job.id}`, { method: "DELETE" }).catch(() => {});
  }
}

// A command's output beyond what Activity's terminal shows a reader is left out.
const OUTPUT_CHARS = 2000;
function trimOutput<E extends DemoTimeline["events"][number]>(event: E): E {
  const data = event.data as { chunk?: unknown };
  if (
    event.type !== "tool.output" ||
    typeof data.chunk !== "string" ||
    data.chunk.length <= OUTPUT_CHARS
  )
    return event;
  return { ...event, data: { ...data, chunk: `${data.chunk.slice(0, OUTPUT_CHARS)}\n…` } };
}

for (const demo of config.demos.filter((d) => !only || d.id === only)) {
  if (!demo.reviewed) throw new Error(`${demo.id}: review the recording first.`);
  const all = (await (
    await get(`/api/sessions/${demo.sessionId}/events`)
  ).json()) as DemoTimeline["events"];
  const events = demo.until === undefined ? all : all.filter((e) => e.t <= (demo.until ?? 0) * 1e6);
  const end = events.findLast((e) => e.type === "session.end");
  const spend = events.findLast((e) => e.type === "model.spend") as
    | { data: { taskSpentUSD?: number; route?: string; model?: string } }
    | undefined;
  const usage = events.find((e) => e.type === "model.usage") as
    | { data: { route: string; model: string } }
    | undefined;
  let at = 0;
  const segments: Segment[] = demo.cuts.map((cut) => {
    const segment = { from: cut.from * 1000, to: cut.to * 1000, speed: cut.speed, at };
    at += (segment.to - segment.from) / segment.speed;
    return segment;
  });
  const dir = join(OUT, demo.id);
  mkdirSync(dir, { recursive: true });
  const video = join(dir, "theatre.mp4");
  const parts: string[] = [];
  if (demo.video === "raw") {
    const raw = join(tmpdir(), `${demo.sessionId}.mp4`);
    writeFileSync(
      raw,
      Buffer.from(
        await (await get(`/api/sessions/${demo.sessionId}/recording/video.mp4`)).arrayBuffer(),
      ),
    );
    for (const [i, s] of segments.entries()) {
      const part = join(tmpdir(), `${demo.id}-${i}.mp4`);
      ffmpeg([
        "-ss",
        String(s.from / 1000),
        "-to",
        String(s.to / 1000),
        "-i",
        raw,
        "-an",
        "-vf",
        `setpts=(PTS-STARTPTS)/${s.speed},fps=30,scale=1920:-2:flags=lanczos`,
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        part,
      ]);
      parts.push(part);
    }
  } else {
    for (const [i, s] of segments.entries()) {
      const part = join(tmpdir(), `${demo.id}-${i}.mp4`);
      await exported(demo.sessionId, s, part);
      parts.push(part);
      console.log(`${demo.id}: cut ${i + 1}/${segments.length} exported`);
    }
  }
  // One file, with a keyframe every two seconds: enough for the story to wind it back, and half the
  // size of one every half second for a detailed screen.
  const list = join(tmpdir(), `${demo.id}-parts.txt`);
  writeFileSync(list, parts.map((p) => `file '${p}'`).join("\n"));
  const encode = (width: number, crf: number, out: string) =>
    ffmpeg([
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      list,
      "-an",
      "-filter_complex",
      theatreFilter(width, demo.freeze),
      "-map",
      "[out]",
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-tune",
      "stillimage",
      "-crf",
      String(crf),
      "-g",
      "60",
      "-keyint_min",
      "30",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      out,
    ]);
  encode(1920, 25, video);
  // Phones show the Theatre a few hundred pixels wide.
  encode(1280, 27, join(dir, "theatre-sm.mp4"));
  const still = join(tmpdir(), `${demo.id}-poster.png`);
  ffmpeg(["-ss", "0.5", "-i", video, "-frames:v", "1", still]);
  execFileSync("cwebp", ["-quiet", "-q", "82", still, "-o", join(dir, "poster.webp")]);
  const probe = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height:format=duration",
      "-of",
      "json",
      video,
    ],
    { encoding: "utf8" },
  );
  const { streams, format } = JSON.parse(probe) as {
    streams: { width: number; height: number }[];
    format: { duration: string };
  };
  // The files dot handed over, with what the app's file viewer asks about them. They sit where the
  // app's preview links point, so a picture the viewer draws from its link is a plain file.
  const previews = `/file-previews/${previewTicket(demo.id)}/`;
  const shelf = join(OUT, "..", previews);
  rmSync(shelf, { recursive: true, force: true });
  mkdirSync(shelf, { recursive: true });
  const api: DemoTimeline["api"] = {};
  // `path` is under the task's /api/agent/sessions/<id>/, or its recording's /api/sessions/<id>/
  // when it starts "session/".
  const keep = async (path: string, saved: string) => {
    const url = path.startsWith("session/")
      ? `/api/sessions/${demo.sessionId}/${path.slice("session/".length)}`
      : `/api/agent/sessions/${demo.sessionId}/${path}`;
    const response = await get(url).catch(() => null);
    if (!response) return;
    const type =
      (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0] ?? "";
    let body = Buffer.from(await response.arrayBuffer());
    // A video result is shown in a web-sized copy.
    if (/\.(mp4|mov|webm)$/i.test(saved) && body.length > 5 * 1024 * 1024) {
      const big = join(tmpdir(), `${demo.id}-result-big`);
      const small = join(tmpdir(), `${demo.id}-result-small.mp4`);
      writeFileSync(big, body);
      ffmpeg([
        "-i",
        big,
        "-vf",
        "scale=-2:1280",
        "-c:v",
        "libx264",
        "-preset",
        "slow",
        "-crf",
        "26",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        small,
      ]);
      body = readFileSync(small);
    }
    writeFileSync(join(shelf, saved), body);
    api[path] = { src: `${previews}${encodeURIComponent(saved)}`, type };
  };
  await keep("proof", "proof.json");
  // The moments the proof shows from the recording.
  const proof = JSON.parse(readFileSync(join(shelf, "proof.json"), "utf8").toString() || "{}") as {
    results?: { frames?: { frameId: string }[] }[];
  };
  for (const result of proof.results ?? [])
    for (const { frameId } of result.frames ?? []) {
      await keep(`session/thumbs/${frameId}`, `thumb-${frameId}`);
      await keep(`session/frames/${frameId}`, `frame-${frameId}`);
    }
  const result = events.findLast((e) => e.type === "task.result") as
    | { data: { files?: { name: string }[] } }
    | undefined;
  for (const { name } of result?.data.files ?? []) {
    const file = `files/${encodeURIComponent(name)}`;
    await keep(file, name);
    for (const part of ["preview", "pages", "versions", "text"])
      await keep(`${file}/${part}`, `${name}.${part}`);
    // A spreadsheet is shown a sheet at a time.
    await keep(`${file}/table?sheet=0`, `${name}.table-0`);
    if (!api[`${file}/table?sheet=0`]) continue;
    const first = JSON.parse(readFileSync(join(shelf, `${name}.table-0`), "utf8")) as {
      kind?: string;
      sheets?: string[];
    };
    if (first.kind !== "table") continue;
    for (let sheet = 1; sheet < (first.sheets?.length ?? 1); sheet++)
      await keep(`${file}/table?sheet=${sheet}`, `${name}.table-${sheet}`);
  }
  const timeline: DemoTimeline = {
    v: 1,
    id: demo.id,
    sessionId: demo.sessionId,
    title: demo.title,
    prompt: demo.prompt,
    persona: demo.persona,
    model: {
      route: usage?.data.route ?? "",
      model: usage?.data.model ?? "",
      label: demo.modelLabel,
    },
    ...(spend?.data.taskSpentUSD !== undefined ? { costUSD: spend.data.taskSpentUSD } : {}),
    realMs: end ? Math.round(end.t / 1000) : Math.round((events.at(-1)?.t ?? 0) / 1000),
    video: {
      src: `/demos/${demo.id}/theatre.mp4`,
      small: `/demos/${demo.id}/theatre-sm.mp4`,
      poster: `/demos/${demo.id}/poster.webp`,
      width: streams[0]?.width ?? 1920,
      height: streams[0]?.height ?? 1200,
      ms: Math.round(Number(format.duration) * 1000),
    },
    segments,
    events: prune(events).map(trimOutput),
    results: demo.results ?? [],
    api,
    previews,
  };
  writeFileSync(join(dir, "timeline.json"), JSON.stringify(timeline));
  for (const card of demo.cards ?? []) {
    const raw = join(tmpdir(), `${demo.id}-card-${card.name}.mp4`);
    const segment = { from: card.from * 1000, to: card.to * 1000, speed: card.speed, at: 0 };
    await exported(demo.sessionId, segment, raw, {
      captions: card.captions ?? false,
      ...(card.dot ? { dot: card.dot } : {}),
      // With dot under the picture the video is taller by its band (the app's withBand at 1280).
      size: card.dot === "under" ? { w: 1280, h: 940 } : { w: 1280, h: 800 },
    });
    ffmpeg([
      "-i",
      raw,
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "27",
      "-g",
      "60",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      join(dir, `card-${card.name}.mp4`),
    ]);
    console.log(`${demo.id}: card ${card.name}`);
  }
  console.log(
    `${demo.id}: ${timeline.events.length} events, ${(timeline.video.ms / 1000).toFixed(1)} s video`,
  );
}
