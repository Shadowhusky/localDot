import { randomUUID } from "node:crypto";
import { ulid } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import { browserGatewayDevice } from "./gateway-device.ts";

function fixture(scale: 1 | 2 = 2) {
  const permit = {
    browserCellId: ulid(),
    parentCellId: ulid(),
    instance: randomUUID(),
    revision: 1,
    requestId: ulid(),
    owner: { sessionId: ulid(), generation: 1 },
  };
  const abort = new AbortController();
  let allowed = true;
  let reply = () => {};
  const target = {
    point: { x: 40, y: 50 },
    bbox: { x: 20, y: 30, w: 40, h: 40 },
    source: "ax" as const,
    name: "Continue",
    role: "button",
  };
  const client = {
    clock: vi.fn(async () => ({ mono: 50 })),
    settle: vi.fn(async () => ({
      changed: [{ x: 2, y: 4, w: 40, h: 50 }],
      lastChangeMono: 50,
      quiet: true,
      noVisibleChange: false,
    })),
    lookup: vi.fn(async () => {
      reply();
      return { target, window: null, ms: 1 };
    }),
    observe: vi.fn(async () => {
      reply();
      return {
        frame: {
          frameId: ulid(),
          image: "masked",
          width: 1280 as const,
          height: 800 as const,
          pointer: { x: 40, y: 50 },
          windows: [],
        },
        targets: [target],
      };
    }),
    input: vi.fn(async () => {
      reply();
      return { armedMono: 50, pressMono: 51, presses: [51], injector: "xtest" as const };
    }),
    type: vi.fn<Parameters<typeof browserGatewayDevice>[0]["client"]["type"]>(
      async (_permit, _tab, _request, _scope, progress) => {
        reply();
        await progress?.({ count: 1, pressMono: 51 });
        return { done: true, count: 1, armedMono: 50, firstPressMono: 51, injector: "xtest" };
      },
    ),
  };
  const lease = {
    selection: {
      screen: "browser" as const,
      cellId: permit.browserCellId,
      revision: 1,
      geometry: { w: 1280 as const, h: 800 as const, scale },
    },
    signal: abort.signal,
    check: () => {
      if (!allowed || abort.signal.aborted) throw new Error("expired screen");
    },
    finish: () => {
      allowed = false;
    },
  };
  const options = { client, lease, permit, tabId: randomUUID(), now: () => 100_000 };
  const device = browserGatewayDevice(options);
  return {
    options,
    device,
    client,
    lease,
    abort,
    onReply: (fn: () => void) => {
      reply = fn;
    },
  };
}

describe("leased browser gateway device", () => {
  it.each([1, 2] as const)(
    "preserves model pixels and maps native coordinates at scale %s",
    async (scale) => {
      const f = fixture(scale);
      expect((await f.device.client.observe()).pointer).toEqual({ x: 40 * scale, y: 50 * scale });
      const result = await f.device.client.hitTest({ x: 40 * scale, y: 50 * scale });
      expect(f.client.lookup).toHaveBeenLastCalledWith(
        f.options.permit,
        f.options.tabId,
        { kind: "hitTest", point: { x: 40, y: 50 } },
        expect.anything(),
      );
      expect(result.target).toMatchObject({
        point: { x: 40 * scale, y: 50 * scale },
        bbox: { x: 20 * scale, y: 30 * scale, w: 40 * scale, h: 40 * scale },
      });
      const request = {
        input: {
          kind: "click" as const,
          at: { x: 40 * scale, y: 50 * scale },
          button: "left" as const,
          count: 1 as const,
        },
        injector: "xtest" as const,
        holdMs: 0,
      };
      await f.device.client.input(request);
      expect(f.client.input).toHaveBeenCalledWith(
        f.options.permit,
        f.options.tabId,
        { ...request, input: { ...request.input, at: { x: 40, y: 50 } } },
        expect.anything(),
      );
      expect((await f.device.client.settle()).changed).toEqual([{ x: 2, y: 4, w: 40, h: 50 }]);
      await f.device.clocks.sync(2);
      expect(f.device.clocks.toDaemonMicros(50)).toBe(100_000);
    },
  );
  it("refuses a finished screen lease before and after asynchronous service replies", async () => {
    const f = fixture();
    f.onReply(() => f.lease.finish());
    await expect(f.device.client.observe()).rejects.toThrow("expired screen");
    await expect(
      f.device.client.input({
        input: { kind: "move", to: { x: 1, y: 1 } },
        injector: "xtest",
        holdMs: 0,
      }),
    ).rejects.toThrow("expired screen");
    expect(f.client.input).not.toHaveBeenCalled();
  });
  it("does not deliver progress after takeover and does not accept a foreign window", async () => {
    const f = fixture();
    const request = {
      text: "A",
      masked: false,
      pace: { firstCount: 1, firstMs: 0, restMs: 0 },
      injector: "xtest" as const,
    };
    const progress = vi.fn();
    await expect(f.device.client.type({ ...request, window: 9 }, progress)).rejects.toThrow(
      "request",
    );
    expect(f.client.type).not.toHaveBeenCalled();
    f.onReply(() => f.abort.abort());
    await expect(f.device.client.type(request, progress)).rejects.toThrow();
    expect(progress).not.toHaveBeenCalled();
  });
  it("pins the grant identity and refuses cross-screen construction", async () => {
    const f = fixture();
    f.options.permit.owner.generation = 99;
    await f.device.client.clock();
    expect(f.client.clock).toHaveBeenCalledWith(
      expect.objectContaining({ owner: expect.objectContaining({ generation: 1 }) }),
      f.options.tabId,
      expect.anything(),
    );
    expect(() =>
      browserGatewayDevice({
        ...f.options,
        permit: { ...f.options.permit, browserCellId: ulid() },
      }),
    ).toThrow("stale");
  });
});
