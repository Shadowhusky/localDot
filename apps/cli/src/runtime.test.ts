import { afterEach, expect, it, vi } from "vitest";
import type { ServiceConfiguration } from "../../../packages/protocol/src/install-services.ts";
import { runtime } from "./runtime.ts";

const mocks = vi.hoisted(() => ({ installed: vi.fn(), doctor: vi.fn(), socket: vi.fn() }));
vi.mock("./install/doctor.ts", () => ({ runInstalledDoctor: mocks.installed }));
vi.mock("../../daemon/src/doctor.ts", () => ({ runDoctor: mocks.doctor }));
vi.mock("../../daemon/src/doctor-socket.ts", () => ({ findDockerSocket: mocks.socket }));
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
