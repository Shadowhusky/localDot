import { describe, expect, it, vi } from "vitest";
import { parsePort } from "../../daemon/src/port.ts";
import { HELP, parseArgs } from "./args.ts";
import { runCli } from "./run.ts";
import type { CommandContextInput } from "./runtime.ts";

const cell = "01JXYZ00000000000000000001";
function fixture(args: string[], env: NodeJS.ProcessEnv = {}) {
  const controller = new AbortController();
  const io = { out: vi.fn(), err: vi.fn() };
  const runtime = {
    context: vi.fn(async (input: CommandContextInput) => ({
      ...input,
      port: parsePort(input.env.LOCALDOT_PORT),
    })),
    default: vi.fn(async () => 0),
    up: vi.fn(async () => 0),
    startAtLogin: vi.fn(async () => 0),
    update: vi.fn(async () => 0),
    down: vi.fn(async () => 0),
    logs: vi.fn(async () => 0),
    open: vi.fn(async () => 0),
    stop: vi.fn(async () => 0),
    resetComputer: vi.fn(async () => 0),
    doctor: vi.fn(async () => 0),
    recover: vi.fn(async () => 0),
    unlock: vi.fn(async () => 0),
  };
  return {
    controller,
    io,
    runtime,
    run: () => runCli({ args, env, version: "1.2.3", signal: controller.signal }, io, runtime),
  };
}

describe("operational CLI dispatch", () => {
  it.each([undefined, "2.3.4-rc.1"])(
    "dispatches update with target %s without ambient settings",
    async (version) => {
      const f = fixture(version ? ["update", "--to", version] : ["update"], {
        LOCALDOT_HOME: "/private/test-home",
        LOCALDOT_PORT: "invalid",
        DOCKER_HOST: "unrelated",
      });
      expect(await f.run()).toBe(0);
      expect(f.runtime.update).toHaveBeenCalledExactlyOnceWith(
        { home: "/private/test-home", signal: f.controller.signal, version },
        f.io,
      );
      expect(f.runtime.context).not.toHaveBeenCalled();
    },
  );
  it("rejects ambiguous, mutable or malformed update targets without echoing them", async () => {
    for (const args of [
      ["update", "latest"],
      ["update", "--to", "latest"],
      ["update", "--to", "private-value"],
      ["update", "--to", "2.3.4", "--force"],
      ["update", "--to", "2.3.4", "--to", "3.0.0"],
    ]) {
      const f = fixture(args);
      expect(await f.run()).toBe(2);
      expect(f.runtime.update).not.toHaveBeenCalled();
      expect(JSON.stringify(f.io.err.mock.calls)).not.toContain("private-value");
    }
  });
  it("explains destructive reset without resolving configuration or touching any runtime", async () => {
    const f = fixture(["reset-computer", "--cell", cell], { LOCALDOT_PORT: "invalid" });
    expect(await f.run()).toBe(0);
    for (const operation of Object.values(f.runtime)) expect(operation).not.toHaveBeenCalled();
    expect(JSON.stringify(f.io.out.mock.calls)).toContain("--erase-computer");
  });
  it.each(["--erase-computer", "--status"])(
    "dispatches an explicit reset operation with installed configuration: %s",
    async (flag) => {
      const requestId = "01JXYZ00000000000000000002";
      const f = fixture(["reset-computer", "--request", requestId, "--cell", cell, flag], {
        LOCALDOT_PORT: "invalid",
      });
      f.runtime.context.mockImplementation(async (input) => ({ ...input, port: 4891 }));
      expect(await f.run()).toBe(0);
      expect(f.runtime.resetComputer).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          cellId: cell,
          requestId,
          port: 4891,
          operation: flag === "--status" ? "status" : "reset",
        }),
        f.io,
      );
    },
  );
  it("refuses ambiguous reset flags, implicit targets and invalid request IDs", () => {
    for (const flags of [
      [],
      ["--erase-computer"],
      ["--cell", cell, "--status"],
      ["--cell", cell, "--erase-computer", "--status"],
      ["--cell", cell, "--cell", cell],
      ["--cell", cell, "--request", "invalid"],
      ["--cell", cell, "--force"],
      ["--cell", cell, "--erase-computer", "--erase-computer"],
    ])
      expect(parseArgs(["reset-computer", ...flags])).toBeUndefined();
  });
  it.each(["open", "stop", "doctor"])("uses resolved installed context for %s", async (command) => {
    const f = fixture([command], { LOCALDOT_PORT: "invalid" });
    f.runtime.context.mockImplementation(async (input) => ({ ...input, port: 4891 }));
    expect(await f.run()).toBe(0);
    expect(f.runtime[command as "open" | "stop" | "doctor"]).toHaveBeenCalledWith(
      expect.objectContaining({ port: 4891 }),
      f.io,
      ...(command === "open" ? [{}] : []),
    );
  });
  it("asks open for a QR code only with --qr", async () => {
    const f = fixture(["open", "--qr"]);
    expect(await f.run()).toBe(0);
    expect(f.runtime.open).toHaveBeenCalledExactlyOnceWith(expect.anything(), f.io, { qr: true });
    for (const args of [
      ["open", "--qr", "--qr"],
      ["open", "--QR"],
      ["open", "qr"],
    ])
      expect(parseArgs(args)).toBeUndefined();
  });
  it("routes unlock to keyd's home without resolving the daemon's context", async () => {
    const f = fixture(["unlock"], {
      LOCALDOT_HOME: "/private/test-home",
      LOCALDOT_PORT: "invalid",
    });
    expect(await f.run()).toBe(0);
    expect(f.runtime.context).not.toHaveBeenCalled();
    expect(f.runtime.unlock).toHaveBeenCalledExactlyOnceWith(
      { home: "/private/test-home", signal: f.controller.signal },
      f.io,
    );
  });
  it("does not dispatch after cancellation during context discovery", async () => {
    const f = fixture(["stop"]);
    f.runtime.context.mockImplementation(async (input) => {
      f.controller.abort();
      return { ...input, port: 4891 };
    });
    expect(await f.run()).toBe(130);
    expect(f.runtime.stop).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "routes logs with follow=%s without parsing ambient ports",
    async (follow) => {
      const f = fixture(follow ? ["logs", "--follow"] : ["logs"], {
        LOCALDOT_HOME: "/private/test-home",
        LOCALDOT_PORT: "invalid",
        DOCKER_HOST: "unrelated",
      });
      expect(await f.run()).toBe(0);
      expect(f.runtime.logs).toHaveBeenCalledExactlyOnceWith(
        { home: "/private/test-home", signal: f.controller.signal, follow },
        f.io,
      );
      expect(parseArgs(["logs", "--file", "/private/elsewhere"])).toBeUndefined();
      expect(parseArgs(["logs", "--follow", "--follow"])).toBeUndefined();
    },
  );
  it("routes no arguments to setup without parsing existing-install port overrides", async () => {
    const env = { LOCALDOT_HOME: "/private/test-home", LOCALDOT_PORT: "invalid" };
    const f = fixture([], env);
    expect(await f.run()).toBe(0);
    expect(f.runtime.default).toHaveBeenCalledExactlyOnceWith(
      { home: env.LOCALDOT_HOME, env, version: "1.2.3", signal: f.controller.signal },
      f.io,
    );
    expect(f.runtime.doctor).not.toHaveBeenCalled();
  });
  it("routes up without using ambient port or Docker overrides", async () => {
    const f = fixture(["up"], {
      LOCALDOT_HOME: "/private/test-home",
      LOCALDOT_PORT: "invalid",
      DOCKER_HOST: "unrelated",
    });
    expect(await f.run()).toBe(0);
    expect(f.runtime.up).toHaveBeenCalledExactlyOnceWith(
      { home: "/private/test-home", signal: f.controller.signal },
      f.io,
    );
    expect(f.runtime.down).not.toHaveBeenCalled();
    expect(parseArgs(["up", "--force"])).toBeUndefined();
  });
  it("routes down without requiring a valid ambient port or Docker setting", async () => {
    const f = fixture(["down"], {
      LOCALDOT_HOME: "/private/test-home",
      LOCALDOT_PORT: "invalid",
      DOCKER_HOST: "unrelated",
    });
    expect(await f.run()).toBe(0);
    expect(f.runtime.down).toHaveBeenCalledExactlyOnceWith(
      { home: "/private/test-home", signal: f.controller.signal },
      f.io,
    );
    expect(f.runtime.stop).not.toHaveBeenCalled();
    expect(parseArgs(["down", "--force"])).toBeUndefined();
  });
  it("refuses malformed commands and flags before touching the runtime", async () => {
    for (const args of [
      ["OPEN"],
      ["open", "--token", "private-value"],
      ["stop", "--cell"],
      ["stop", "--cell", "../bad"],
      ["doctor", "--", "extra"],
    ]) {
      const f = fixture(args);
      expect(await f.run()).toBe(2);
      for (const operation of Object.values(f.runtime)) expect(operation).not.toHaveBeenCalled();
      expect(JSON.stringify(f.io.err.mock.calls)).not.toContain("private-value");
    }
    expect(parseArgs(["stop", "--cell", cell])).toEqual({ kind: "stop", cellId: cell });
  });
  it("help and version work without an installation or valid runtime settings", async () => {
    for (const args of [["--help"], ["--version"]]) {
      const f = fixture(args, { LOCALDOT_PORT: "invalid", LOCALDOT_HOME: "/does-not-exist" });
      expect(await f.run()).toBe(0);
      for (const operation of Object.values(f.runtime)) expect(operation).not.toHaveBeenCalled();
      expect(f.io.err).not.toHaveBeenCalled();
    }
  });
  it("routes home, port, cancellation and the chosen computer to the existing Stop client", async () => {
    const f = fixture(["stop", "--cell", cell], {
      LOCALDOT_HOME: "/private/test-home",
      LOCALDOT_PORT: "4891",
    });
    f.runtime.stop.mockResolvedValue(2);
    expect(await f.run()).toBe(2);
    expect(f.runtime.stop).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        home: "/private/test-home",
        port: 4891,
        cellId: cell,
        signal: f.controller.signal,
      }),
      f.io,
    );
    expect(f.runtime.open).not.toHaveBeenCalled();
    expect(f.runtime.doctor).not.toHaveBeenCalled();
  });
  it("does not echo invalid settings or exception messages", async () => {
    const f = fixture(["open"], { LOCALDOT_PORT: "private-value" });
    expect(await f.run()).toBe(1);
    expect(f.runtime.open).not.toHaveBeenCalled();
    expect(JSON.stringify(f.io.err.mock.calls)).not.toContain("private-value");
    const g = fixture(["doctor"]);
    g.runtime.doctor.mockRejectedValue(new Error("private-value"));
    expect(await g.run()).toBe(1);
    expect(JSON.stringify(g.io.err.mock.calls)).not.toContain("private-value");
  });
  it("does not start work after cancellation", async () => {
    const f = fixture(["stop"]);
    f.controller.abort();
    expect(await f.run()).toBe(130);
    expect(f.runtime.stop).not.toHaveBeenCalled();
  });
});

describe("start at login commands", () => {
  it.each([
    [["up", "--at-login"], { kind: "up", atLogin: true }],
    [["up", "--from-login"], { kind: "up", fromLogin: true }],
    [["start-at-login", "on"], { kind: "start-at-login", operation: "on" }],
    [["start-at-login", "off"], { kind: "start-at-login", operation: "off" }],
    [["start-at-login", "status"], { kind: "start-at-login", operation: "status" }],
  ])("parses %j", (args, command) => {
    expect(parseArgs(args)).toEqual(command);
  });
  it.each([
    [["up", "--at-login", "--from-login"]],
    [["up", "--at-login", "--at-login"]],
    [["up", "--login"]],
    [["start-at-login"]],
    [["start-at-login", "maybe"]],
  ])("refuses %j", (args) => {
    expect(parseArgs(args)).toBeUndefined();
  });
  it("documents start at login in help", () => {
    expect(HELP).toContain("localdot start-at-login on|off|status");
    expect(HELP).toContain("localdot up --at-login");
    expect(HELP).not.toContain("--from-login");
  });
  it("routes up --at-login with its option", async () => {
    const f = fixture(["up", "--at-login"], { LOCALDOT_HOME: "/private/test-home" });
    expect(await f.run()).toBe(0);
    expect(f.runtime.up).toHaveBeenCalledExactlyOnceWith(
      { home: "/private/test-home", signal: f.controller.signal },
      f.io,
      { atLogin: true },
    );
  });
  it("routes start-at-login without resolving the daemon context", async () => {
    const f = fixture(["start-at-login", "status"], { LOCALDOT_HOME: "/private/test-home" });
    expect(await f.run()).toBe(0);
    expect(f.runtime.startAtLogin).toHaveBeenCalledExactlyOnceWith(
      { home: "/private/test-home", signal: f.controller.signal },
      "status",
      f.io,
    );
    expect(f.runtime.context).not.toHaveBeenCalled();
  });
});

describe("stop everything", () => {
  it("parses stop --all and refuses mixing it with --cell", () => {
    expect(parseArgs(["stop", "--all"])).toEqual({ kind: "stop", all: true });
    expect(parseArgs(["stop", "--all", "--cell", cell])).toBeUndefined();
    expect(HELP).toContain("localdot stop --all");
  });
  it("routes stop --all to the stop runtime", async () => {
    const f = fixture(["stop", "--all"], { LOCALDOT_HOME: "/private/test-home" });
    expect(await f.run()).toBe(0);
    expect(f.runtime.stop).toHaveBeenCalledWith(expect.objectContaining({ all: true }), f.io);
  });
});

it("doctor --fix stops localDot, starts it, then runs fresh diagnostics", async () => {
  const f = fixture(["doctor", "--fix"]);
  expect(await f.run()).toBe(0);
  const calls = [f.runtime.down, f.runtime.up, f.runtime.context, f.runtime.doctor].map(
    (fn) => fn.mock.invocationCallOrder[0],
  );
  expect(calls).toEqual([...calls].sort((a, b) => (a ?? 0) - (b ?? 0)));
  expect(f.runtime.stop).not.toHaveBeenCalled();
});
it.each(["down", "up"] as const)("doctor --fix stops after a failed %s", async (operation) => {
  const f = fixture(["doctor", "--fix"]);
  f.runtime[operation].mockResolvedValue(1);
  expect(await f.run()).toBe(1);
  expect(f.runtime.doctor).not.toHaveBeenCalled();
  if (operation === "down") expect(f.runtime.up).not.toHaveBeenCalled();
});
it("doctor requires an explicit fix flag before restarting anything", async () => {
  const f = fixture(["doctor"]);
  expect(await f.run()).toBe(0);
  expect(f.runtime.down).not.toHaveBeenCalled();
  expect(f.runtime.up).not.toHaveBeenCalled();
  expect(parseArgs(["doctor", "--fix", "--force"])).toBeUndefined();
});

it("requires an exact computer identity and explicit native exit confirmation", () => {
  const id = "01M4PT514STKGMY0HC4Y0AGQCY";
  expect(parseArgs(["recover", "--cell", id])).toEqual({ kind: "recover", cellId: id });
  expect(parseArgs(["recover", "--cell", id, "--confirm-native-exit"])).toEqual({
    kind: "recover",
    cellId: id,
    confirmNativeExit: true,
  });
  for (const args of [
    ["recover"],
    ["recover", "--cell", "all"],
    ["recover", "--cell", id, "--force"],
    ["recover", "--cell", id, "--confirm-native-exit", "extra"],
  ])
    expect(parseArgs(args)).toBeUndefined();
});
