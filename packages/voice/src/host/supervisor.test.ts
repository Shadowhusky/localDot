import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeChild } from "./fake-voiced.ts";
import { type SpawnLike, VoicedSupervisor } from "./supervisor.ts";

const setup = (healthy: () => boolean = () => true) => {
  const children: FakeChild[] = [];
  const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv; detached: boolean }[] =
    [];
  const spawn: SpawnLike = (command, args, options) => {
    calls.push({ command, args, env: options.env, detached: options.detached });
    const child = new FakeChild();
    child.pid = 4000 + children.length;
    children.push(child);
    return child;
  };
  // Each fake child stands for its whole process group.
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    children.find((child) => child.pid === -pid)?.kill(signal as NodeJS.Signals);
    return true;
  });
  const fetch = vi.fn(async () =>
    healthy()
      ? new Response(JSON.stringify({ ok: true, voice: "stock", slots: {} }), { status: 200 })
      : new Response("down", { status: 503 }),
  );
  const supervisor = new VoicedSupervisor({
    command: ["uv", "run", "voiced"],
    voiceDir: "/packs/voice",
    env: {
      PATH: "/usr/bin",
      HOME: "/Users/me",
      LOCALDOT_ASR: "accurate",
      LOCALDOT_LMSTUDIO_URL: "http://127.0.0.1:1234",
      LOCALDOT_VOICED_IDLE_S: "300",
      ELEVENLABS_API_KEY: "secret",
      AZURE_SPEECH_KEY: "secret",
    },
    spawn,
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  return { supervisor, children, calls, fetch };
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("VoicedSupervisor", () => {
  it("starts voiced with only the variables it needs, never a provider key", () => {
    const { supervisor, calls } = setup();
    supervisor.start();
    expect(calls[0]?.command).toBe("uv");
    expect(calls[0]?.args).toEqual(["run", "voiced"]);
    expect(calls[0]?.env).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/me",
      LOCALDOT_ASR: "accurate",
      LOCALDOT_LMSTUDIO_URL: "http://127.0.0.1:1234",
      LOCALDOT_VOICED_IDLE_S: "300",
      LOCALDOT_VOICED_TOKEN: supervisor.token,
      LOCALDOT_VOICED_PORT: "4752",
      LOCALDOT_VOICED_PARENT_PID: String(process.pid),
      LOCALDOT_VOICE_DIR: "/packs/voice",
    });
    expect(supervisor.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("is ready once /health answers with its token", async () => {
    const { supervisor, fetch } = setup();
    supervisor.start();
    expect(supervisor.status).toBe("starting");
    await vi.advanceTimersByTimeAsync(500);
    expect(supervisor.status).toBe("ready");
    expect(supervisor.health?.voice).toBe("stock");
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4752/health",
      expect.objectContaining({ headers: { authorization: `Bearer ${supervisor.token}` } }),
    );
  });

  it("restarts a crashed voiced with growing backoff", async () => {
    const { supervisor, children } = setup();
    supervisor.start();
    await vi.advanceTimersByTimeAsync(500);
    children[0]?.exit(1);
    expect(supervisor.status).toBe("restarting");
    await vi.advanceTimersByTimeAsync(999);
    expect(children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(children).toHaveLength(2);
    children[1]?.exit(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(children).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(children).toHaveLength(3);
  });

  it("restarts voiced after three failed health checks in a row", async () => {
    let healthy = true;
    const { supervisor, children } = setup(() => healthy);
    supervisor.start();
    await vi.advanceTimersByTimeAsync(500);
    healthy = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(children[0]?.signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(children[0]?.signals).toEqual(["SIGTERM"]);
    expect(supervisor.status).toBe("restarting");
  });

  it("stops without restarting, killing a voiced that ignores SIGTERM", async () => {
    const { supervisor, children } = setup();
    supervisor.start();
    await vi.advanceTimersByTimeAsync(500);
    const child = children[0] as FakeChild;
    child.diesOnTerm = false;
    const stopped = supervisor.stop();
    await vi.advanceTimersByTimeAsync(5000);
    await stopped;
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(1);
    expect(supervisor.status).toBe("stopped");
  });

  it("gives up on a start that never becomes healthy and tries again", async () => {
    const { supervisor, children } = setup(() => false);
    supervisor.start();
    await vi.advanceTimersByTimeAsync(120_500);
    expect(children[0]?.signals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(children).toHaveLength(2);
  });

  it("tells waiters when voiced is ready, or that it is not within their time", async () => {
    const { supervisor } = setup();
    expect(await supervisor.whenReady(10)).toBe(false);
    supervisor.start();
    const ready = supervisor.whenReady(5000);
    await vi.advanceTimersByTimeAsync(500);
    expect(await ready).toBe(true);
  });

  it("starts voiced in its own process group and signals the whole group", async () => {
    let healthy = true;
    const { supervisor, children, calls } = setup(() => healthy);
    supervisor.start();
    await vi.advanceTimersByTimeAsync(500);
    healthy = false;
    await vi.advanceTimersByTimeAsync(15_000);
    healthy = true;
    await vi.advanceTimersByTimeAsync(1000);
    await supervisor.stop();
    expect(calls.map((call) => call.detached)).toEqual([true, true]);
    expect(vi.mocked(process.kill).mock.calls).toEqual([
      [-4000, "SIGTERM"],
      [-4001, "SIGTERM"],
    ]);
    expect(children.map((child) => child.signals)).toEqual([["SIGTERM"], ["SIGTERM"]]);
  });

  it("kills a voiced that ignores SIGTERM when restarting it", async () => {
    let healthy = true;
    const { supervisor, children } = setup(() => healthy);
    supervisor.start();
    await vi.advanceTimersByTimeAsync(500);
    const child = children[0] as FakeChild;
    child.diesOnTerm = false;
    healthy = false;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(supervisor.status).toBe("restarting");
    await vi.advanceTimersByTimeAsync(5000);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    healthy = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(children).toHaveLength(2);
  });

  it("survives a voiced that cannot be started, keeps the reason, and tries again", async () => {
    const { supervisor, children } = setup();
    supervisor.start();
    children[0]?.fail(new Error("spawn uv ENOENT"));
    expect(supervisor.status).toBe("restarting");
    expect(supervisor.stderrTail).toContain("spawn uv ENOENT");
    await vi.advanceTimersByTimeAsync(1000);
    expect(children).toHaveLength(2);
  });
});
