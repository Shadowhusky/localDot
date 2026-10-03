import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CodexProcess, CodexProcessError, spawnCodex } from "./process.ts";

const records: CodexProcess[] = [];
const fakeClosers: Array<() => void> = [];
const required = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) throw new Error("Test fixture stream is missing.");
  return value;
};
afterEach(async () => {
  for (const close of fakeClosers.splice(0)) close();
  for (const p of records.splice(0)) await p.stop().catch(() => {});
  vi.useRealTimers();
});
function fake() {
  const signal = new AbortController(),
    child = Object.assign(new EventEmitter(), {
      pid: 87654,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ChildProcess;
  let gone = false;
  const kills: Array<[number, NodeJS.Signals | 0]> = [];
  const kill = vi.fn((pid: number, s: NodeJS.Signals | 0) => {
    kills.push([pid, s]);
    if (gone) throw Object.assign(new Error("inert missing group"), { code: "ESRCH" });
  });
  const close = (code: number | null = 0, reason: NodeJS.Signals | null = null) => {
    gone = true;
    child.emit("exit", code, reason);
    required(child.stdin).destroy();
    required(child.stdout).destroy();
    required(child.stderr).destroy();
    child.emit("close", code, reason);
  };
  fakeClosers.push(close);
  const markGone = () => {
    gone = true;
  };
  const spawnImpl = vi.fn(() => child) as unknown as typeof spawn;
  const owners: CodexProcess[] = [];
  const input = {
    command: process.execPath,
    args: ["-e", ""],
    cwd: "/tmp",
    env: { PATH: "/usr/bin:/bin" },
    signal: signal.signal,
    register: (p: CodexProcess) => {
      owners.push(p);
    },
    spawnImpl,
    killImpl: kill,
  };
  return { child, signal, kills, kill, close, markGone, input, owners, spawnImpl };
}
const create = (f: ReturnType<typeof fake>) => {
  const p = spawnCodex(f.input);
  records.push(p);
  return p;
};
describe("owned process boundary", () => {
  it("reserves ownership before spawn and resolves readiness only from spawn", async () => {
    const f = fake();
    f.input.spawnImpl = vi.fn(() => {
      expect(f.owners).toHaveLength(1);
      return f.child;
    }) as unknown as typeof spawn;
    const p = create(f);
    let ready = false;
    void p.started
      .then(() => {
        ready = true;
      })
      .catch(() => {});
    await Promise.resolve();
    expect(ready).toBe(false);
    f.child.emit("spawn");
    await p.started;
    expect(p.pid).toBe(87654);
    f.close();
    await p.closed;
  });
  it("does not spawn for an already aborted request", async () => {
    const f = fake();
    f.signal.abort();
    const p = create(f);
    await expect(p.started).rejects.toMatchObject({ code: "cancelled" });
    await p.closed;
    expect(f.spawnImpl).not.toHaveBeenCalled();
    expect(f.kills).toEqual([]);
  });
  it("allows its registered owner to Stop before any process exists", async () => {
    const f = fake();
    f.input.register = (p) => {
      f.owners.push(p);
      void p.stop();
    };
    const p = create(f);
    await p.closed;
    await expect(p.started).rejects.toMatchObject({ code: "cancelled" });
    expect(f.spawnImpl).not.toHaveBeenCalled();
  });
  it("does not spawn after an owner registration exception", async () => {
    const f = fake();
    f.input.register = () => {
      throw new Error("sentinel credential must remain private");
    };
    const p = create(f);
    await expect(p.started).rejects.toMatchObject({ code: "process_startup_failed" });
    await p.closed;
    expect(f.spawnImpl).not.toHaveBeenCalled();
  });
  it("refuses asynchronous registration and consumes its rejection before any spawn", async () => {
    const f = fake();
    f.input.register = (() => Promise.reject(new Error("FAKE-SECRET"))) as unknown as (
      p: CodexProcess,
    ) => void;
    const p = create(f);
    await expect(p.started).rejects.toMatchObject({ code: "process_startup_failed" });
    await p.closed;
    expect(f.spawnImpl).not.toHaveBeenCalled();
  });
  it("owns a synchronous spawn exception without leaking the cause", async () => {
    const f = fake();
    f.input.spawnImpl = vi.fn(() => {
      throw new Error("FAKE-AUTH-and-socket-secret");
    }) as unknown as typeof spawn;
    const p = create(f);
    await expect(p.started).rejects.toEqual(new CodexProcessError("process_startup_failed"));
    await p.closed;
    expect(f.kills).toEqual([]);
  });
  it("handles ENOENT with missing PID through close instead of awaiting an impossible exit", async () => {
    const f = fake();
    Object.assign(f.child, { pid: undefined });
    const p = create(f);
    f.child.emit("error", Object.assign(new Error("FAKE-AUTH"), { code: "ENOENT" }));
    f.close(null);
    await expect(p.started).rejects.toMatchObject({ code: "process_startup_failed" });
    await p.closed;
    expect(f.kills).toEqual([]);
  });
  it("stops an abort occurring synchronously inside spawn after registering its listeners", async () => {
    vi.useFakeTimers();
    const f = fake();
    f.input.spawnImpl = vi.fn(() => {
      f.signal.abort();
      return f.child;
    }) as unknown as typeof spawn;
    const p = create(f);
    await expect(p.started).rejects.toMatchObject({ code: "cancelled" });
    await vi.advanceTimersByTimeAsync(250);
    expect(f.kills).toContainEqual([-87654, "SIGTERM"]);
    f.close();
    await p.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("fences and sends best-effort interrupt once without waiting before EOF or fixed deadlines", async () => {
    vi.useFakeTimers();
    const f = fake(),
      order: string[] = [];
    required(f.child.stdin).on("finish", () => order.push("stdin"));
    const p = spawnCodex({
      ...f.input,
      fence: () => order.push("fence"),
      interrupt: () => {
        order.push("interrupt");
        return new Promise<void>(() => {});
      },
    });
    records.push(p);
    f.child.emit("spawn");
    await p.started;
    const stop = p.stop();
    expect(p.stop()).toBe(stop);
    expect(order.slice(0, 2)).toEqual(["fence", "interrupt"]);
    await vi.advanceTimersByTimeAsync(249);
    expect(f.kills.filter((x) => x[1] !== 0)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.kills).toContainEqual([-87654, "SIGTERM"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.kills).toContainEqual([-87654, "SIGKILL"]);
    f.close(null, "SIGKILL");
    await stop;
    expect(order).toContain("stdin");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("clears every listener/timer after a synchronous close during stdin EOF", async () => {
    vi.useFakeTimers();
    const f = fake(),
      p = create(f);
    f.child.emit("spawn");
    await p.started;
    f.child.stdin?.on("finish", () => f.close());
    await p.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.child.listenerCount("error")).toBe(0);
    const before = f.kills.length;
    await p.stop();
    expect(f.kills).toHaveLength(before);
  });
  it("keeps exit distinct from final pipe and group closure", async () => {
    vi.useFakeTimers();
    const f = fake(),
      p = create(f);
    f.child.emit("spawn");
    await p.started;
    const chunks: string[] = [];
    required(p.stdout).on("data", (b) => chunks.push(String(b)));
    const stop = p.stop();
    f.markGone();
    f.child.emit("exit", 0, null);
    expect(await p.exited).toEqual({ code: 0, signal: null });
    let closed = false;
    p.closed.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    (f.child.stdout as PassThrough).write("last bytes");
    f.close();
    await stop;
    expect(chunks).toEqual(["last bytes"]);
    expect(closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("fences and contains an exited parent while descendant-held pipes remain open", async () => {
    vi.useFakeTimers();
    const f = fake(),
      fence = vi.fn();
    const p = spawnCodex({ ...f.input, fence });
    records.push(p);
    f.child.emit("spawn");
    await p.started;
    f.child.emit("exit", 0, null);
    expect(await p.exited).toEqual({ code: 0, signal: null });
    expect(fence).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(f.kills).toContainEqual([-87654, "SIGTERM"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.kills).toContainEqual([-87654, "SIGKILL"]);
    await vi.advanceTimersByTimeAsync(750);
    await expect(p.stop()).rejects.toMatchObject({ code: "process_shutdown_failed" });
    let retired = false;
    p.closed.then(() => {
      retired = true;
    });
    await Promise.resolve();
    expect(retired).toBe(false);
    f.close();
    await p.closed;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("reports a safe shutdown failure after2 seconds while retaining unconfirmed ownership", async () => {
    vi.useFakeTimers();
    const f = fake(),
      p = create(f);
    f.child.emit("spawn");
    await p.started;
    const stop = p.stop();
    let closed = false;
    p.closed.then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(stop).rejects.toEqual(new CodexProcessError("process_shutdown_failed"));
    expect(closed).toBe(false);
    expect(p.stop()).toBe(stop);
    expect(f.owners).toEqual([p]);
    expect(vi.getTimerCount()).toBe(0);
    f.close();
    await p.closed;
  });
  it("does not mistake a non-ESRCH signal exception for confirmed retirement", async () => {
    vi.useFakeTimers();
    const f = fake();
    let denied = true;
    f.input.killImpl = vi.fn((pid, signal) => {
      if (denied) throw Object.assign(new Error("FAKE-AUTH"), { code: "EPERM" });
      return f.kill(pid, signal);
    });
    const p = create(f);
    f.child.emit("spawn");
    await p.started;
    const stop = p.stop();
    await vi.advanceTimersByTimeAsync(2000);
    await expect(stop).rejects.toMatchObject({ code: "process_shutdown_failed" });
    let closed = false;
    p.closed.then(() => {
      closed = true;
    });
    f.close();
    await Promise.resolve();
    expect(closed).toBe(false);
    // The inert owned group is later independently confirmed gone; the failed Stop stays failed.
    denied = false;
    f.child.emit("close", 0, null);
    await p.closed;
    await expect(stop).rejects.toMatchObject({ code: "process_shutdown_failed" });
  });
  it.each(["stdin", "stdout", "stderr"] as const)(
    "handles an owned %s stream error without unhandled errors or raw diagnostics",
    async (name) => {
      vi.useFakeTimers();
      const f = fake(),
        p = create(f);
      f.child.emit("spawn");
      await p.started;
      required(f.child[name]).emit(
        "error",
        Object.assign(new Error("FAKE-AUTH-AND-SOCKET"), { code: "EPIPE" }),
      );
      expect(await p.failure).toEqual(new CodexProcessError("process_transport_failed"));
      expect(p.stop()).toBe(p.stop());
      f.close();
      await p.stop();
    },
  );
  it("consumes rejected interrupt/fence callbacks and still reaches shutdown", async () => {
    const f = fake(),
      p = spawnCodex({
        ...f.input,
        fence: () => {
          throw new Error("FAKE-SECRET");
        },
        interrupt: () => Promise.reject(new Error("FAKE-SECRET")),
      });
    records.push(p);
    f.child.emit("spawn");
    await p.started;
    const stop = p.stop();
    f.close();
    await stop;
    expect(await p.failure).toMatchObject({ code: "process_transport_failed" });
  });
});
describe("harmless owned Node process acceptance", () => {
  const launch = (script: string) => {
    const p = spawnCodex({
      command: process.execPath,
      args: ["-e", script],
      cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin", HOME: "/tmp" },
      signal: new AbortController().signal,
      register: () => {},
    });
    records.push(p);
    return p;
  };
  it("passes exactly the explicit environment and drains stdout through close", async () => {
    const p = launch("process.stdout.write(JSON.stringify(process.env))");
    let out = "";
    required(p.stdout).on("data", (d) => {
      out += d;
    });
    await p.started;
    await p.closed;
    const actual = JSON.parse(out);
    // On this Mac a child has a system text-encoding value in addition to the explicit env.
    if (process.platform === "darwin") {
      expect(actual.__CF_USER_TEXT_ENCODING).toMatch(/^0x[0-9a-fA-F]+:[0-9]+:[0-9]+$/);
      delete actual.__CF_USER_TEXT_ENCODING;
    }
    expect(actual).toEqual({ PATH: "/usr/bin:/bin", HOME: "/tmp" });
    expect(await p.exited).toEqual({ code: 0, signal: null });
  });
  it("allows EOF to finish without signaling a gone group", async () => {
    const p = launch(
      "process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('final');process.exitCode=0;})",
    );
    await p.started;
    const out: string[] = [];
    required(p.stdout).on("data", (b) => out.push(String(b)));
    await p.stop();
    expect(await p.exited).toEqual({ code: 0, signal: null });
    expect(out.join("")).toBe("final");
  });
  it("terminates its private child/grandchild group when both ignore EOF and TERM", async () => {
    const p = launch(
      "process.on('SIGTERM',()=>{});const {spawn}=require('node:child_process');const g=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});console.log(g.pid);setInterval(()=>{},1000);",
    );
    await p.started;
    const grandchild = await new Promise<number>((resolve) =>
      required(p.stdout).once("data", (d) => resolve(Number(String(d).trim()))),
    );
    expect(grandchild).toBeGreaterThan(0);
    await p.stop();
    expect(await p.exited).toEqual({ code: null, signal: "SIGKILL" });
    await p.closed;
    expect(() => process.kill(grandchild, 0)).toThrow();
  }, 5000);
});
