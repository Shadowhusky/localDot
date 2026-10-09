import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExportsState, HostExport } from "@localdot/protocol";
import { expect, test } from "@playwright/test";
import { seedHome } from "./seed.ts";
import { skipSetup } from "./skip-setup.ts";

// One real export on this computer: the daemon's headless Chrome makes the video while no page is
// open, and a restart in the middle of one leaves it failed with a retry that works.
const DAEMON = fileURLToPath(new URL("../../daemon", import.meta.url));
const PORT = Number(process.env.LOCALDOT_E2E_PORT) || 4790;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let scratch: string;
let home: string;
let sessionId: string;
let docker: Server;
let daemon: ChildProcess | undefined;
let token = "";

async function startDaemon() {
  daemon = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: DAEMON,
    env: {
      ...process.env,
      DOCKER_HOST: `unix://${join(scratch, "docker.sock")}`,
      LOCALDOT_HOME: home,
      LOCALDOT_PORT: String(PORT),
    },
    stdio: "ignore",
  });
  for (let tries = 0; tries < 240; tries++) {
    try {
      token = readFileSync(join(home, "daemon-token"), "utf8").trim();
      if ((await call("/api/whoami")).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The daemon did not start.");
}

async function stopDaemon() {
  if (!daemon || daemon.exitCode !== null) return;
  const exited = once(daemon, "exit");
  daemon.kill("SIGTERM");
  await exited;
}

function call(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body) headers.set("content-type", "application/json");
  return fetch(`${ORIGIN}${path}`, { ...init, headers, signal: AbortSignal.timeout(30_000) });
}

async function exportsState(): Promise<ExportsState> {
  return (await (await call("/api/exports")).json()) as ExportsState;
}

async function until(id: string, phases: HostExport["phase"][], ms = 240_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = (await exportsState()).exports.find((entry) => entry.id === id);
    if (found && phases.includes(found.phase)) return found;
    if (Date.now() > deadline) throw new Error(`export ${id} stayed ${found?.phase}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const request = (patch: Record<string, unknown> = {}) => ({
  sessionId,
  fromMs: 0,
  toMs: 120_000,
  speed: 1,
  skipIdle: false,
  captions: true,
  overlays: true,
  size: { w: 1280, h: 800 },
  fps: 30,
  quality: "high",
  format: "mp4",
  ...patch,
});

test.beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "localdot-host-export-"));
  ({
    home,
    seed: { sessionId },
  } = seedHome({
    home: join(scratch, "home"),
    minutes: 3,
    title: "Organize the sample workspace",
  }));
  docker = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && /\/containers\/json(?:\?|$)/.test(req.url ?? "")) res.end("[]");
    else {
      res.writeHead(404);
      res.end('{"message":"isolated export fixture"}');
    }
  });
  docker.listen(join(scratch, "docker.sock"));
  await once(docker, "listening");
  await startDaemon();
});

test.afterAll(async () => {
  await stopDaemon();
  docker?.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("the host makes the video after the page that asked for it is gone", async ({ page }) => {
  const deadline = Date.now() + 60_000;
  let state = await exportsState();
  while (state.host.state === "checking" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    state = await exportsState();
  }
  test.skip(state.host.state !== "ready", "No browser on this computer can make videos.");

  await skipSetup(page);
  await page.goto(`${ORIGIN}/?replay=${sessionId}&replayProbe=1#token=${token}`);
  await page.waitForFunction(() => window.__localdot?.replay?.status() === "ready", undefined, {
    timeout: 60_000,
  });
  await page.getByRole("button", { name: "Export video" }).click({ force: true, timeout: 30_000 });
  await page.getByRole("radio", { name: "Fast" }).click({ force: true });
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(
    page.getByText("It keeps going if you close this page or switch apps."),
  ).toBeVisible();
  const started = (await exportsState()).exports[0];
  expect(started?.phase).toMatch(/queued|making/);
  await page.close();

  const made = await until(started?.id ?? "", ["done", "failed"]);
  expect(made).toMatchObject({ phase: "done", error: null });
  const link = (await (await call(`/api/exports/${made.id}/link`, { method: "POST" })).json()) as {
    href: string;
  };
  const file = await fetch(`${ORIGIN}${link.href}`);
  expect(file.headers.get("content-disposition")).toContain(made.name);
  const saved = join(scratch, made.name);
  writeFileSync(saved, Buffer.from(await file.arrayBuffer()));
  const probe = JSON.parse(
    execFileSync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_name,width,height",
      "-of",
      "json",
      saved,
    ]).toString(),
  ) as { format: { duration: string }; streams: { codec_name: string; width: number }[] };
  expect(probe.streams[0]).toMatchObject({ codec_name: "h264", width: made.request.size.w });
  expect(Math.abs(Number(probe.format.duration) - (made.durationS ?? 0))).toBeLessThan(0.1);
});

test("a restart in the middle of a video fails it, and trying again makes it", async () => {
  test.skip((await exportsState()).host.state !== "ready", "No browser can make videos here.");
  const response = await call("/api/exports", {
    method: "POST",
    body: JSON.stringify({
      request: request({ size: { w: 2560, h: 1600 }, fps: 60 }),
      screen: "desktop",
    }),
  });
  expect(response.status).toBe(201);
  const started = (await response.json()) as HostExport;
  await until(started.id, ["making"]);
  await stopDaemon();
  await startDaemon();
  const interrupted = await until(started.id, ["failed"], 5_000);
  expect(interrupted.error).toContain("restarted");
  const deadline = Date.now() + 60_000;
  while ((await exportsState()).host.state !== "ready" && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 250));
  expect((await call(`/api/exports/${started.id}/retry`, { method: "POST" })).status).toBe(200);
  expect((await until(started.id, ["done", "failed"])).phase).toBe("done");
});
