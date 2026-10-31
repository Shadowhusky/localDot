import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ulid } from "../../../packages/protocol/src/ids.ts";
import { ComputerFences } from "../../daemon/src/agent/safety/fences.ts";
import { NativeConfirmations } from "../../daemon/src/agent/safety/native-confirmations.ts";
import { runRecoverComputer } from "./recover-computer.ts";

const mock = vi.hoisted(() => ({ contain: vi.fn(), state: vi.fn(() => "legacy") }));
vi.mock("./install/container-containment.ts", () => ({
  containHomeContainers: mock.contain,
  readContainerInventory: vi.fn(),
}));
vi.mock("./install/container-client.ts", () => ({ installContainerClient: vi.fn() }));
vi.mock("../../daemon/src/agent/safety/native-tasks.ts", () => ({
  nativeTaskState: mock.state,
  interruptedNativeTasks: () => [],
}));
const roots: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  mock.state.mockReturnValue("legacy");
  mock.contain.mockResolvedValue(undefined);
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
function fixture(executor: "api" | "native" = "native") {
  const home = realpathSync(mkdtempSync("/tmp/dot-recover-"));
  roots.push(home);
  chmodSync(home, 0o700);
  const cellId = ulid(),
    session = ulid();
  new ComputerFences(home).capture(cellId, session, executor);
  writeFileSync(join(home, "kept.txt"), "saved data");
  return {
    home,
    cellId,
    session,
    context: {
      home,
      cellId,
      port: 4750,
      signal: new AbortController().signal,
      env: { DOCKER_HOST: "unix:///test/docker.sock" },
    },
    io: { out: vi.fn(), err: vi.fn() },
  };
}
it("requires the explicit confirmation flag and does nothing on preview", async () => {
  const f = fixture();
  expect(await runRecoverComputer(f.context, f.io)).toBe(0);
  expect(f.io.out).toHaveBeenCalledWith(expect.stringContaining("--confirm-native-exit"));
  expect(mock.contain).not.toHaveBeenCalled();
  expect(new ComputerFences(f.home).record(f.cellId)?.nativeRetired).toBe(false);
});
it("points a computer held by an API task to Replace computer, with nothing to confirm", async () => {
  const f = fixture("api");
  const before = readFileSync(join(f.home, "safety", "fences", `${f.cellId}.json`), "utf8");
  expect(await runRecoverComputer(f.context, f.io)).toBe(0);
  expect(f.io.out).toHaveBeenCalledWith(expect.stringContaining("choose Replace computer"));
  expect(f.io.out).not.toHaveBeenCalledWith(expect.stringContaining("--confirm-native-exit"));
  expect(await runRecoverComputer({ ...f.context, confirmNativeExit: true }, f.io)).toBe(1);
  expect(f.io.err).toHaveBeenCalledWith(expect.stringContaining("no native exit to confirm"));
  expect(mock.contain).not.toHaveBeenCalled();
  expect(readFileSync(join(f.home, "safety", "fences", `${f.cellId}.json`), "utf8")).toBe(before);
});
it("says a confirmed native exit leaves only Replace computer", async () => {
  const f = fixture();
  new ComputerFences(f.home).confirmNativeRetirement(f.cellId, f.session);
  expect(await runRecoverComputer(f.context, f.io)).toBe(0);
  expect(f.io.out).toHaveBeenCalledWith(
    expect.stringMatching(/^The old native task's exit is already confirmed\. Open localDot/),
  );
});
it("records the user's confirmation while retaining the fence and saved files", async () => {
  const f = fixture();
  expect(await runRecoverComputer({ ...f.context, confirmNativeExit: true }, f.io)).toBe(0);
  const fences = new ComputerFences(f.home);
  expect(fences.record(f.cellId)?.nativeRetired).toBe(true);
  expect(fences.isFenced(f.cellId)).toBe(true);
  expect(new NativeConfirmations(f.home).read(f.cellId)).toMatchObject({
    sessionId: f.session,
    source: "user-confirmed-native-exit",
  });
  expect(readFileSync(join(f.home, "kept.txt"), "utf8")).toBe("saved data");
});
it("refuses a known live group even with user confirmation", async () => {
  const f = fixture();
  mock.state.mockReturnValue("alive");
  expect(await runRecoverComputer({ ...f.context, confirmNativeExit: true }, f.io)).toBe(1);
  expect(mock.contain).not.toHaveBeenCalled();
  expect(new ComputerFences(f.home).record(f.cellId)?.nativeRetired).toBe(false);
});
it("does not confirm recovery when container shutdown is unverified", async () => {
  const f = fixture();
  mock.contain.mockRejectedValue(new Error("failed"));
  expect(await runRecoverComputer({ ...f.context, confirmNativeExit: true }, f.io)).toBe(1);
  expect(new ComputerFences(f.home).record(f.cellId)?.nativeRetired).toBe(false);
});
it("does not act while a daemon holds its lock", async () => {
  const f = fixture();
  writeFileSync(join(f.home, "daemon.lock"), String(process.pid));
  expect(await runRecoverComputer({ ...f.context, confirmNativeExit: true }, f.io)).toBe(1);
  expect(mock.contain).not.toHaveBeenCalled();
});
