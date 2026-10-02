import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeDocker, startFakeDocker } from "./cells/testing/fake-docker.ts";

const DAEMON = fileURLToPath(new URL("..", import.meta.url));
const MAIN = fileURLToPath(new URL("./doctor-main.ts", import.meta.url));

let fake: FakeDocker | undefined;
let home: string | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

const waitUntil = (pred: () => boolean, ms: number) =>
  new Promise<void>((resolve) => {
    const deadline = Date.now() + ms;
    const check = () => (pred() || Date.now() > deadline ? resolve() : setTimeout(check, 10));
    check();
  });

describe("the doctor command", () => {
  it("finishes removing its probe network when interrupted mid-probe, then exits 130", async () => {
    const docker = await startFakeDocker();
    fake = docker;
    const create = Promise.withResolvers<void>();
    docker.state.holds.set("POST /networks/create", create.promise);
    home = mkdtempSync("/tmp/ld-doctor-test-");
    const child = spawn(process.execPath, ["--import", "tsx", MAIN], {
      cwd: DAEMON,
      env: {
        ...process.env,
        DOCKER_HOST: `unix://${docker.socketPath}`,
        LOCALDOT_PORT: String(await freePort()),
        LOCALDOT_HOME: home,
      },
      stdio: "ignore",
    });
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    const creating = () =>
      docker.state.calls.some((c) => c.method === "POST" && c.path === "/networks/create");
    await waitUntil(creating, 20_000);
    expect(creating()).toBe(true);

    child.kill("SIGINT");
    await new Promise((r) => setTimeout(r, 200));
    create.resolve();

    expect(await exited).toBe(130);
    expect(docker.state.networks.size).toBe(0);
  }, 30_000);
});
