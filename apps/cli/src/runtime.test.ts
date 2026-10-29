import { afterEach, expect, it, vi } from "vitest";
import type { ServiceConfiguration } from "../../../packages/protocol/src/install-services.ts";
import { runtime } from "./runtime.ts";

const mocks = vi.hoisted(() => ({
  installed: vi.fn(),
  doctor: vi.fn(),
  socket: vi.fn(),
  managed: vi.fn(),
  runUp: vi.fn(),
  runDown: vi.fn(),
  host: vi.fn(),
  up: vi.fn(),
  down: vi.fn(),
  restart: vi.fn(),
}));
vi.mock("./install/doctor.ts", () => ({ runInstalledDoctor: mocks.installed }));
vi.mock("../../daemon/src/doctor.ts", () => ({ runDoctor: mocks.doctor }));
vi.mock("../../daemon/src/doctor-socket.ts", () => ({ findDockerSocket: mocks.socket }));
vi.mock("./install/initialize-home.ts", () => ({ hasInstallState: mocks.managed }));
vi.mock("./install/up.ts", () => ({ runUp: mocks.runUp }));
vi.mock("./install/down.ts", () => ({ runDown: mocks.runDown }));
vi.mock("./local-dot.ts", async (actual) => ({
  ...(await actual<typeof import("./local-dot.ts")>()),
  hostLocalDot: mocks.host,
}));
vi.mock("./lifecycle.ts", () => ({
  upLocalDot: mocks.up,
  downLocalDot: mocks.down,
  restartLocalDot: mocks.restart,
  startAtLoginLocalDot: vi.fn(),
}));
afterEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
});
it.each([0, 1, 130])(
  "routes managed doctor to ownership-aware diagnostics and propagates %i",
  async (result) => {
    const context = {
      home: "/private/fixture",
      port: 4891,
      signal: new AbortController().signal,
      installed: {} as ServiceConfiguration,
      env: { DOCKER_HOST: "tcp://unrelated", LOCALDOT_DESKTOP_IMAGE: "wrong:dev" },
    };
    const io = { out: vi.fn(), err: vi.fn() };
    mocks.installed.mockResolvedValue(result);
    expect(await runtime.doctor(context, io)).toBe(result);
    expect(mocks.installed).toHaveBeenCalledWith(context, io);
    expect(mocks.socket).not.toHaveBeenCalled();
    expect(mocks.doctor).not.toHaveBeenCalled();
  },
);
it("keeps unmanaged development diagnostics separate", async () => {
  mocks.socket.mockReturnValue({ path: "/fixture/docker.sock", source: "fixture" });
  mocks.doctor.mockResolvedValue({
    ok: false,
    checks: [{ name: "fixture", ok: false, detail: "unavailable" }],
  });
  const env = {},
    io = { out: vi.fn(), err: vi.fn() };
  expect(
    await runtime.doctor(
      { home: "/fixture", port: 4891, signal: new AbortController().signal, env },
      io,
    ),
  ).toBe(1);
  expect(mocks.installed).not.toHaveBeenCalled();
  expect(mocks.socket).toHaveBeenCalledWith(env);
  expect(io.out).toHaveBeenCalledWith(expect.stringContaining("FAIL fixture"));
});
it("does not begin diagnostics after cancellation", async () => {
  await expect(
    runtime.doctor(
      { home: "/fixture", port: 4891, signal: AbortSignal.abort(), env: {} },
      { out: vi.fn(), err: vi.fn() },
    ),
  ).rejects.toThrow();
  expect(mocks.installed).not.toHaveBeenCalled();
  expect(mocks.socket).not.toHaveBeenCalled();
});

it.each([false, true])(
  "keeps pending vault setup distinct from runtime failures (other failure: %s)",
  async (otherFailure) => {
    mocks.socket.mockReturnValue({ path: "/fixture/docker.sock", source: "fixture" });
    mocks.doctor.mockResolvedValue({
      ok: false,
      checks: [
        {
          name: "key-vault",
          ok: false,
          pendingAction: "unlock-vault",
          detail: "Run localdot unlock",
        },
        { name: "isolated-gateway-mode", ok: !otherFailure, detail: "isolation check" },
      ],
    });
    const io = { out: vi.fn(), err: vi.fn() };
    expect(
      await runtime.doctor(
        { home: "/fixture", port: 4891, signal: new AbortController().signal, env: {} },
        io,
      ),
    ).toBe(otherFailure ? 1 : 2);
    expect(io.out).toHaveBeenCalledWith(expect.stringContaining("next key-vault"));
  },
);

it.each(["none", "vault", "isolation"])(
  "keeps existing computer recovery separate from app startup (%s)",
  async (other) => {
    mocks.socket.mockReturnValue({ path: "/fixture/docker.sock", source: "fixture" });
    mocks.doctor.mockResolvedValue({
      ok: false,
      checks: [
        {
          name: "computer-recovery",
          ok: false,
          pendingAction: "recover-computer",
          detail: "Native task exit has not been confirmed. Keep the saved computer data.",
        },
        ...(other === "none"
          ? []
          : [
              {
                name: other,
                ok: false,
                ...(other === "vault" ? { pendingAction: "unlock-vault" } : {}),
                detail: "needs attention",
              },
            ]),
      ],
    });
    const io = { out: vi.fn(), err: vi.fn() };
    expect(
      await runtime.doctor(
        { home: "/fixture", port: 4891, signal: new AbortController().signal, env: {} },
        io,
      ),
    ).toBe(other === "none" ? 0 : other === "vault" ? 2 : 1);
    expect(io.out).toHaveBeenCalledWith(expect.stringContaining("next computer-recovery"));
  },
);

it.each([true, false])(
  "starts and stops through the install journal only for a managed installation (%s)",
  async (managed) => {
    const local = { name: "localDot" };
    mocks.managed.mockResolvedValue(managed);
    mocks.host.mockResolvedValue(local);
    for (const fn of [mocks.runUp, mocks.runDown, mocks.up, mocks.down]) fn.mockResolvedValue(0);
    const context = { home: "/private/fixture", env: {}, signal: new AbortController().signal };
    const io = { out: vi.fn(), err: vi.fn() };
    expect(await runtime.up(context, io)).toBe(0);
    expect(await runtime.down(context, io)).toBe(0);
    if (managed) {
      expect(mocks.runUp).toHaveBeenCalledWith(context, io, undefined);
      expect(mocks.runDown).toHaveBeenCalledWith(context, io);
      expect(mocks.host).not.toHaveBeenCalled();
    } else {
      expect(mocks.up).toHaveBeenCalledWith(local, io, undefined);
      expect(mocks.down).toHaveBeenCalledWith(local, io);
      expect(mocks.runUp).not.toHaveBeenCalled();
    }
  },
);

it("restarts whatever kind of installation this is through one command", async () => {
  const local = { name: "localDot" };
  mocks.host.mockResolvedValue(local);
  mocks.restart.mockResolvedValue(0);
  const context = { home: "/private/fixture", env: {}, signal: new AbortController().signal };
  const io = { out: vi.fn(), err: vi.fn() };
  expect(await runtime.restart(context, io)).toBe(0);
  expect(mocks.host).toHaveBeenCalledWith(context);
  expect(mocks.restart).toHaveBeenCalledWith(local, io);
});
