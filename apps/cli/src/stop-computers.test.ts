import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { lockHolder } from "../../daemon/src/lock.ts";
import { parseArgs } from "./args.ts";
import { runStopComputers } from "./stop-computers.ts";

const mocks = vi.hoisted(() => ({ contain: vi.fn(), client: vi.fn() }));
vi.mock("./install/container-client.ts", () => ({ installContainerClient: mocks.client }));
vi.mock("./install/container-containment.ts", () => ({
  containHomeContainers: mocks.contain,
  readContainerInventory: vi.fn(),
}));
const roots: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "dot-stop-")));
  roots.push(home);
  await chmod(home, 0o700);
  return {
    context: {
      home,
      port: 4750,
      env: { DOCKER_HOST: "unix:///test/docker.sock" },
      signal: new AbortController().signal,
    },
    io: { out: vi.fn(), err: vi.fn() },
  };
}
it("takes the daemon lock until independent container verification completes", async () => {
  const f = await fixture();
  mocks.contain.mockImplementation(async () => {
    expect(lockHolder(join(f.context.home, "daemon.lock"))).toBe(process.pid);
  });
  expect(await runStopComputers(f.context, f.io)).toBe(0);
  expect(mocks.contain).toHaveBeenCalledOnce();
  expect(lockHolder(join(f.context.home, "daemon.lock"))).toBeUndefined();
  expect(f.io.out).toHaveBeenCalledOnce();
});
it("does not certify shutdown or touch containers while keyd remains running", async () => {
  const f = await fixture();
  await mkdir(join(f.context.home, "keyd"), { mode: 0o700 });
  await writeFile(join(f.context.home, "keyd/keyd.lock"), String(process.pid), { mode: 0o600 });
  expect(await runStopComputers(f.context, f.io)).toBe(1);
  expect(mocks.contain).not.toHaveBeenCalled();
  expect(f.io.out).not.toHaveBeenCalled();
});
it("reports failed containment and releases the lock for a later retry", async () => {
  const f = await fixture();
  mocks.contain.mockRejectedValue(new Error("unconfirmed"));
  expect(await runStopComputers(f.context, f.io)).toBe(1);
  expect(f.io.out).not.toHaveBeenCalled();
  expect(f.io.err).toHaveBeenCalledOnce();
  expect(lockHolder(join(f.context.home, "daemon.lock"))).toBeUndefined();
});
it("does not combine full computer shutdown with a task stop", () => {
  expect(parseArgs(["stop", "--computers"])).toEqual({ kind: "stop", computers: true });
  expect(parseArgs(["stop", "--computers", "--all"])).toBeUndefined();
});
