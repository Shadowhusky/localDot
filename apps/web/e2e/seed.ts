import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SeedResult } from "../../daemon/src/recorder/testing/seed-session.ts";
import { type RunningDaemon, startDaemon } from "./daemon.ts";

const DAEMON = fileURLToPath(new URL("../../daemon", import.meta.url));
export interface SeededHome {
  home: string;
  seed: SeedResult;
}

export function seedHome(options: {
  home?: string;
  minutes: number;
  stepsPerMinute?: number;
  title?: string;
  marker?: string;
  takeover?: string;
  video?: boolean;
}): SeededHome {
  const home = options.home ?? join(mkdtempSync(join(tmpdir(), "localdot-replay-")), "home");
  const argumentsList = [
    "--import",
    "tsx",
    "src/seed-main.ts",
    "--home",
    home,
    "--minutes",
    String(options.minutes),
  ];
  if (options.title) argumentsList.push("--title", options.title);
  if (options.stepsPerMinute !== undefined)
    argumentsList.push("--steps-per-minute", String(options.stepsPerMinute));
  if (options.marker) argumentsList.push("--marker", options.marker);
  if (options.takeover) argumentsList.push("--takeover", options.takeover);
  if (options.video === false) argumentsList.push("--no-video");
  const output = execFileSync(process.execPath, argumentsList, {
    cwd: DAEMON,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
  });
  return { home, seed: JSON.parse(output) as SeedResult };
}

export async function startReplayDaemon(home: string): Promise<RunningDaemon> {
  const directory = mkdtempSync(join(tmpdir(), "ldr-"));
  const socket = join(directory, "api.sock");
  const docker = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && /\/containers\/json(?:\?|$)/.test(request.url ?? "")) {
      response.end("[]");
    } else {
      response.writeHead(404);
      response.end('{"message":"isolated replay fixture"}');
    }
  });
  const close = async () => {
    docker.closeAllConnections();
    if (docker.listening) await new Promise<void>((resolve) => docker.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    docker.listen(socket);
    await once(docker, "listening");
    const daemon = await startDaemon({ DOCKER_HOST: `unix://${socket}` }, { home });
    let stopped = false;
    return {
      ...daemon,
      async stop() {
        if (stopped) return;
        stopped = true;
        try {
          await daemon.stop();
        } finally {
          await close();
        }
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
