import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "@playwright/test";

export const TOKEN = "a".repeat(43);
export const ENGINES = {
  chrome: () => chromium.launch({ channel: "chrome" }),
  // The config's channel "chrome" reaches every launch, and WebKit refuses any channel.
  webkit: () => webkit.launch({ channel: undefined }),
};
const WEB = fileURLToPath(new URL("..", import.meta.url));

export interface UiFixture {
  origin: string;
  sessionId: string;
  seeded: string[];
  stop(): Promise<void>;
}

function newest(dir: string): number {
  return Math.max(
    0,
    ...readdirSync(dir, { withFileTypes: true }).map((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return newest(path);
      return /\.test\.tsx?$/.test(entry.name) ? 0 : statSync(path).mtimeMs;
    }),
  );
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(new Error("port")),
      );
    });
  });
}

// The fixture daemon serves the built UI (dist) with a fake computer and two recorded sessions.
export async function startUiFixture(name: string): Promise<UiFixture> {
  if (newest(join(WEB, "src")) > statSync(join(WEB, "dist/index.html")).mtimeMs)
    throw new Error("The built UI is older than src: run pnpm --filter @localdot/web build.");
  const port = await freePort();
  const scratch = mkdtempSync(join(tmpdir(), `${name}-`));
  const fixture = spawn(process.execPath, ["--import", "tsx", "e2e/fixtures/ui-server.ts"], {
    cwd: WEB,
    env: { ...process.env, QA_PORT: String(port), QA_HOME: join(scratch, "home") },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines = createInterface({ input: fixture.stdout as NonNullable<typeof fixture.stdout> });
  const stop = async () => {
    if (fixture.exitCode === null) {
      const exited = new Promise((resolve) => fixture.once("exit", resolve));
      fixture.kill("SIGTERM");
      await exited;
    }
    rmSync(scratch, { recursive: true, force: true });
  };
  try {
    const ready = await new Promise<Omit<UiFixture, "stop">>((resolve, reject) => {
      fixture.once("exit", (code) => reject(new Error(`fixture exited with ${code}`)));
      lines.on("line", (line) => {
        if (line.includes('"ready":true')) resolve(JSON.parse(line));
      });
    });
    return { origin: ready.origin, sessionId: ready.sessionId, seeded: ready.seeded, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
