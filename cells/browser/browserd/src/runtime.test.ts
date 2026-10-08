import { request, type Server } from "node:http";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserProcessDriver } from "./processes.ts";
import type { BrowserReadinessStage } from "./readiness.ts";
import { BROWSER_READINESS_MS, BROWSER_RUNTIME_START_MS, BrowserRuntime } from "./runtime.ts";
import {
  type BrowserProcessName,
  browserProcessSpecs,
  browserRuntimeConfig,
} from "./runtime-config.ts";

const config = browserRuntimeConfig({
  LOCALDOT_BROWSER_CELL_ID: "01J00000000000000000000001",
  LOCALDOT_PARENT_CELL_ID: "01J00000000000000000000002",
  LOCALDOT_BROWSERD_TOKEN: "a".repeat(43),
  LOCALDOT_STREAM_TOKEN: "b".repeat(43),
  LOCALDOT_GATE_ADDR: "172.20.0.2",
  LOCALDOT_SCALE: "2",
});
const order: BrowserProcessName[] = [
  "display",
  "dbus",
  "windowManager",
  "xhelper",
  "capture",
  "forwarder",
  "stream",
  "streamProxy",
  "chromium",
];
const runtimes: BrowserRuntime[] = [];

interface FixtureOptions {
  failStart?: BrowserProcessName;
  failProbe?: BrowserReadinessStage;
  missingChannels?: "xhelper" | "capture" | "chromium";
  prepare?: (signal: AbortSignal) => Promise<void>;
  listen?: (server: Server, signal: AbortSignal) => Promise<void>;
  blockProbe?: (signal: AbortSignal) => Promise<boolean>;
}

function setup(options: FixtureOptions = {}) {
  const specs = browserProcessSpecs(config);
  const started: BrowserProcessName[] = [];
  const signalled: BrowserProcessName[] = [];
  const probes: BrowserReadinessStage[] = [];
  const owners = new Map<
    BrowserProcessName,
    { alive: boolean; failure: () => void; output: PassThrough }
  >();
  const commands: string[] = [];
  const prepare = vi.fn(async (_config, signal: AbortSignal) => options.prepare?.(signal));
  const driver: BrowserProcessDriver = (spec, failure) => {
    const name = order.find(
      (candidate) =>
        specs[candidate].executable === spec.executable &&
        JSON.stringify(specs[candidate].args) === JSON.stringify(spec.args),
    );
    if (!name) throw new Error("unowned process spec");
    started.push(name);
    if (name === options.failStart) throw new Error("synthetic start failure");
    const output = new PassThrough();
    const owner = { alive: true, failure, output };
    owners.set(name, owner);
    const info = {
      targetId: "page",
      type: "page",
      title: "private",
      url: "about:blank",
      attached: false,
    };
    const emit = (value: unknown) => output.write(`${JSON.stringify(value)}\0`);
    const input = new Writable({
      write(chunk, _encoding, complete) {
        if (name === "xhelper") {
          const message = JSON.parse(chunk.toString());
          commands.push(`native:${message.cmd}`);
          queueMicrotask(() =>
            output.write(`${JSON.stringify({ id: message.id, ok: true, mono: 100 })}\n`),
          );
        }
        if (name === "chromium") {
          const message = JSON.parse(chunk.toString().slice(0, -1));
          commands.push(message.method);
          queueMicrotask(() => {
            if (message.method === "Target.setDiscoverTargets")
              emit({ method: "Target.targetCreated", params: { targetInfo: info } });
            if (message.method === "Target.setAutoAttach" && !message.sessionId)
              emit({
                method: "Target.attachedToTarget",
                params: { sessionId: "session", targetInfo: info, waitingForDebugger: true },
              });
            emit({
              id: message.id,
              ...(message.sessionId ? { sessionId: message.sessionId } : {}),
              result:
                message.method === "Browser.getWindowForTarget"
                  ? {
                      windowId: 7,
                      bounds: { left: 0, top: 0, width: 1280, height: 800, windowState: "normal" },
                    }
                  : {},
            });
          });
        }
        complete();
      },
    });
    if (name === "xhelper") output.write(`${JSON.stringify({ ev: "ready", mono: 100 })}\n`);
    if (name === "capture") output.write(Buffer.from("LDCP"));
    return {
      started: Promise.resolve(),
      get closed() {
        return !owner.alive;
      },
      channels:
        name === options.missingChannels || spec.channel === "none" ? {} : { input, output },
      signal: () => {
        signalled.push(name);
        owner.alive = false;
      },
      exists: () => owner.alive,
    };
  };
  const runtime = new BrowserRuntime(config, {
    driver,
    prepare,
    probe: async (stage, signal) => {
      probes.push(stage);
      if (options.blockProbe) return options.blockProbe(signal);
      return stage !== options.failProbe;
    },
    listen:
      options.listen ??
      ((server, signal) =>
        new Promise((resolve, reject) => {
          if (signal.aborted) {
            reject(new Error("cancelled listen"));
            return;
          }
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
          });
        })),
  });
  runtimes.push(runtime);
  return { runtime, started, signalled, probes, prepare, owners, commands };
}

function health(
  server: Server,
  token = config.serviceToken,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server missing port");
  return new Promise((resolve, reject) => {
    const pending = request(
      {
        host: "127.0.0.1",
        port: address.port,
        path: "/health",
        headers: { authorization: `Bearer ${token}` },
        agent: false,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.once("error", reject);
        response.once("end", () =>
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }),
        );
      },
    );
    pending.once("error", reject);
    pending.end();
  });
}

async function settle() {
  for (let step = 0; step < 100; step += 1) await Promise.resolve();
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close().catch(() => {})));
  vi.useRealTimers();
});

describe("assembled browser runtime", () => {
  it("starts each owned process once and publishes authenticated user-held readiness", async () => {
    const fixture = setup();
    expect(fixture.runtime.ready).toBe(false);
    const first = fixture.runtime.start();
    expect(fixture.runtime.start()).toBe(first);
    const service = await first;
    expect(fixture.started).toEqual(order);
    expect(fixture.probes).toEqual([
      "display",
      "monitor",
      "dbus",
      "windowManager",
      "forwarder",
      "stream",
    ]);
    expect(fixture.prepare).toHaveBeenCalledTimes(1);
    expect(fixture.commands).toContain("Page.bringToFront");
    expect(fixture.commands).toContain("native:ping");
    expect(await health(service.server)).toEqual({
      status: 200,
      body: {
        browserCellId: config.browserCellId,
        parentCellId: config.parentCellId,
        instance: fixture.runtime.instance,
        ready: true,
        holder: "user",
        width: 1280,
        height: 800,
      },
    });
    expect((await health(service.server, config.streamToken)).status).toBe(401);
    expect(fixture.runtime.retirement()).toBeUndefined();
    const stop = fixture.runtime.stop();
    expect(fixture.runtime.ready).toBe(false);
    expect(fixture.runtime.stop()).toBe(stop);
    expect(fixture.runtime.retirement()).toBe(stop);
    await stop;
    await fixture.runtime.retired;
    expect([...fixture.owners.values()].every((owner) => !owner.alive)).toBe(true);
    expect((await health(service.server)).body.ready).toBe(false);
  });

  it("a new runtime receives a fresh process identity", async () => {
    const first = setup();
    const second = setup();
    expect(first.runtime.instance).not.toBe(second.runtime.instance);
    await Promise.all([first.runtime.start(), second.runtime.start()]);
  });

  it.each(order)("contains startup failure at %s and never starts successors", async (name) => {
    const fixture = setup({ failStart: name });
    await expect(fixture.runtime.start()).rejects.toThrow();
    expect(fixture.started).toEqual(order.slice(0, order.indexOf(name) + 1));
    expect([...fixture.owners.values()].every((owner) => !owner.alive)).toBe(true);
    expect(fixture.runtime.ready).toBe(false);
    await fixture.runtime.retired;
  });

  it.each(["display", "monitor", "dbus", "windowManager", "forwarder", "stream"] as const)(
    "bounds failed %s readiness",
    async (stage) => {
      vi.useFakeTimers();
      const fixture = setup({ failProbe: stage });
      const startup = fixture.runtime.start();
      const refused = expect(startup).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(BROWSER_READINESS_MS + 1000);
      await refused;
      expect(fixture.runtime.ready).toBe(false);
      expect([...fixture.owners.values()].every((owner) => !owner.alive)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["xhelper", "capture", "chromium"] as const)(
    "refuses missing private %s pipes",
    async (name) => {
      const fixture = setup({ missingChannels: name });
      await expect(fixture.runtime.start()).rejects.toThrow();
      expect(fixture.started.at(-1)).toBe(name);
      expect([...fixture.owners.values()].every((owner) => !owner.alive)).toBe(true);
    },
  );

  it.each(["xhelper", "capture", "chromium"] as const)(
    "internal %s retirement is visible without calling Runtime.stop",
    async (name) => {
      const fixture = setup();
      const service = await fixture.runtime.start();
      const owner = fixture.owners.get(name);
      if (!owner) throw new Error("missing process owner");
      owner.alive = false;
      owner.failure();
      expect(fixture.runtime.ready).toBe(false);
      expect(fixture.runtime.retirement()).toBeDefined();
      await fixture.runtime.retired;
      expect((await health(service.server)).body.ready).toBe(false);
      expect([...fixture.owners.values()].every((member) => !member.alive)).toBe(true);
    },
  );

  it("preparation failure never starts a process", async () => {
    const fixture = setup({
      prepare: async () => {
        throw new Error("private preparation cause");
      },
    });
    await expect(fixture.runtime.start()).rejects.toThrow("Browser runtime refused: startup");
    expect(fixture.started).toEqual([]);
    await fixture.runtime.retired;
  });

  it("Stop before startup creates no process or preparation work", async () => {
    const fixture = setup();
    await fixture.runtime.stop();
    await expect(fixture.runtime.start()).rejects.toThrow();
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(fixture.started).toEqual([]);
  });

  it("Stop during preparation drains that work before acknowledging", async () => {
    const prepared = Promise.withResolvers<void>();
    let aborted = false;
    const fixture = setup({
      prepare: async (signal) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
          },
          { once: true },
        );
        await prepared.promise;
      },
    });
    const startup = fixture.runtime.start();
    const refused = expect(startup).rejects.toThrow();
    await settle();
    let stopped = false;
    const stop = fixture.runtime.stop().then(() => {
      stopped = true;
    });
    expect(aborted).toBe(true);
    await settle();
    expect(stopped).toBe(false);
    prepared.resolve();
    await Promise.all([stop, refused]);
    expect(fixture.started).toEqual([]);
  });

  it("readiness stays false until HTTP listen finishes", async () => {
    const listening = Promise.withResolvers<Server>();
    const release = Promise.withResolvers<void>();
    const fixture = setup({
      listen: async (server) => {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        listening.resolve(server);
        await release.promise;
      },
    });
    const startup = fixture.runtime.start();
    const server = await listening.promise;
    expect((await health(server)).body.ready).toBe(false);
    release.resolve();
    await startup;
    expect((await health(server)).body.ready).toBe(true);
  });

  it("listen failure closes all already started children", async () => {
    const fixture = setup({
      listen: async () => {
        throw new Error("port in use");
      },
    });
    await expect(fixture.runtime.start()).rejects.toThrow();
    expect(fixture.started).toEqual(order);
    expect([...fixture.owners.values()].every((owner) => !owner.alive)).toBe(true);
  });

  it("an abort-aware stuck readiness probe is bounded by the global startup deadline", async () => {
    vi.useFakeTimers();
    const fixture = setup({
      blockProbe: (signal) =>
        new Promise((resolve) =>
          signal.addEventListener("abort", () => resolve(false), { once: true }),
        ),
    });
    const startup = fixture.runtime.start();
    const refused = expect(startup).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(BROWSER_RUNTIME_START_MS + 1000);
    await refused;
    expect(fixture.started).toEqual(["display"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
