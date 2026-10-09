import { afterEach, expect, it, vi } from "vitest";
import { type ServiceLocation, serviceLocation } from "./service-definition.ts";
import { observeServiceJob, parseServiceList, parseUnitState } from "./service-observation.ts";

const run = vi.hoisted(() => vi.fn());
const unitRun = vi.hoisted(() => vi.fn());
vi.mock("./service-command.ts", () => ({
  runServiceObservation: run,
  runUnitObservation: unitRun,
}));
afterEach(() => run.mockReset());
const result = (stdout: string) => ({ code: 0, stderr: "", stdout });
const location = serviceLocation(
  "/private/tmp/state",
  "/private/tmp/home",
  process.getuid?.() ?? -1,
  "a".repeat(32),
  "b".repeat(64),
).daemon;
function context(list = "PID\tStatus\tLabel\n") {
  run.mockImplementation(async (command, signal) => {
    signal.throwIfAborted();
    return result(
      command === "manageruid" ? `${location.uid}\n` : command === "managername" ? "Aqua\n" : list,
    );
  });
}
it("distinguishes loaded-but-idle jobs from absence without parsing print", async () => {
  context(`PID\tStatus\tLabel\n-\t-15\t${location.label}\n123\t0\tforeign label\n`);
  await expect(observeServiceJob(location, new AbortController().signal)).resolves.toEqual({
    pid: null,
  });
  expect(run.mock.calls.map(([op]) => op)).toEqual([
    "manageruid",
    "managername",
    "list",
    "manageruid",
    "managername",
  ]);
  context(`PID\tStatus\tLabel\n123\t0\tforeign label\n`);
  await expect(observeServiceJob(location, new AbortController().signal)).resolves.toBeNull();
});
it("returns running PID only as an observation", () => {
  expect(
    parseServiceList(result(`PID Status Label\n321 0 ${location.label}\n`)).get(location.label),
  ).toBe(321);
});
it.each([
  "",
  "PID\tStatus\tLabel",
  "PID\tExit\tLabel\n",
  "PID Status Label\n\n",
  "PID Status Label\n0 0 test\n",
  "PID Status Label\n2147483648 0 test\n",
  "PID Status Label\n- 2147483648 test\n",
  "PID Status Label\n- -2147483649 test\n",
  "PID Status Label\n- 0 test\n12 0 test\n",
  "PID Status Label\n- 0 bad\u0000name\n",
  "PID Status Label\n- 0 test",
  "x".repeat(128 * 1024 + 1),
])("refuses malformed list case %#", (stdout) => {
  expect(() => parseServiceList(result(stdout))).toThrow("could not be confirmed");
});
it("refuses failed commands even when their output appears empty or valid", () => {
  expect(() => parseServiceList({ ...result("PID Status Label\n"), code: 3 })).toThrow();
  expect(() => parseServiceList({ ...result("PID Status Label\n"), stderr: "warning" })).toThrow();
});
it.each(["uid", "name", "changed-context"])("rejects %s context", async (kind) => {
  context();
  if (kind === "uid") run.mockResolvedValueOnce(result(`${location.uid + 1}\n`));
  if (kind === "name")
    run
      .mockResolvedValueOnce(result(`${location.uid}\n`))
      .mockResolvedValueOnce(result("Background\n"));
  if (kind === "changed-context")
    run
      .mockResolvedValueOnce(result(`${location.uid}\n`))
      .mockResolvedValueOnce(result("Aqua\n"))
      .mockResolvedValueOnce(result("PID Status Label\n"))
      .mockResolvedValueOnce(result(`${location.uid + 1}\n`));
  await expect(observeServiceJob(location, new AbortController().signal)).rejects.toThrow(
    "could not be confirmed",
  );
});
it("refuses forged locations and cancellation before dispatch", async () => {
  context();
  for (const patch of [
    { label: "foreign" },
    { domain: "system" },
    { uid: location.uid + 1 },
    { role: "other" },
  ])
    await expect(
      observeServiceJob({ ...location, ...patch } as ServiceLocation, new AbortController().signal),
    ).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
  const controller = new AbortController();
  controller.abort();
  await expect(observeServiceJob(location, controller.signal)).rejects.toThrow();
});

it("reads a systemd unit as absent, loaded or running, and anything else as unknown", async () => {
  const unit = serviceLocation(
    "/private/tmp/state",
    "/private/tmp/home",
    process.getuid?.() ?? -1,
    "a".repeat(32),
    "b".repeat(64),
    "systemd",
  ).daemon;
  unitRun.mockResolvedValueOnce(result("MainPID=0\nLoadState=not-found\nActiveState=inactive\n"));
  await expect(observeServiceJob(unit, new AbortController().signal)).resolves.toBeNull();
  unitRun.mockResolvedValueOnce(result("MainPID=812\nLoadState=loaded\nActiveState=active\n"));
  await expect(observeServiceJob(unit, new AbortController().signal)).resolves.toEqual({
    pid: 812,
  });
  expect(run).not.toHaveBeenCalled();
  expect(parseUnitState(result("MainPID=0\nLoadState=loaded\nActiveState=inactive\n"))).toEqual({
    pid: null,
  });
  for (const text of [
    "MainPID=0\nLoadState=masked\nActiveState=inactive\n",
    "MainPID=7\nLoadState=not-found\nActiveState=inactive\n",
    "MainPID=0\nLoadState=loaded\n",
    "MainPID=0\nLoadState=loaded\nActiveState=active\nActiveState=active\n",
    "MainPID=0\nLoadState=loaded\nActiveState=active",
    "MainPID=-1\nLoadState=loaded\nActiveState=active\n",
  ])
    expect(() => parseUnitState(result(text))).toThrow();
  expect(() =>
    parseUnitState({ code: 1, stdout: "", stderr: "Failed to connect to bus" }),
  ).toThrow();
});
