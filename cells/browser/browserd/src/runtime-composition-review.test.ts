import { describe, expect, it, vi } from "vitest";
import { BrowserControl } from "./control.ts";
import { BrowserNavigation } from "./navigation-owner.ts";
import { BrowserRuntime } from "./runtime.ts";
import { browserRuntimeConfig } from "./runtime-config.ts";

const identity = {
  browserCellId: "01J00000000000000000000001",
  parentCellId: "01J00000000000000000000002",
  instance: "00000000-0000-4000-8000-000000000003",
};
const permit = {
  ...identity,
  revision: 1,
  requestId: "01J00000000000000000000004",
  owner: { sessionId: "01J00000000000000000000005", generation: 1 },
};
const config = browserRuntimeConfig({
  LOCALDOT_BROWSER_CELL_ID: identity.browserCellId,
  LOCALDOT_PARENT_CELL_ID: identity.parentCellId,
  LOCALDOT_BROWSERD_TOKEN: "a".repeat(43),
  LOCALDOT_STREAM_TOKEN: "b".repeat(43),
  LOCALDOT_GATE_ADDR: "172.20.0.2",
  LOCALDOT_SCALE: "2",
});

async function navigationFixture() {
  const control = new BrowserControl({
    ...identity,
    clearSelections: async () => {},
    secretPages: async () => [],
    reload: async () => {},
  });
  await control.set({ ...permit, holder: "agent" });
  const navigate = vi.fn(async (_tab: string, _url: string, _signal: AbortSignal) => {});
  const navigation = new BrowserNavigation(control, { navigate });
  return { control, navigate, navigation };
}

async function settle() {
  for (let index = 0; index < 40; index += 1) await Promise.resolve();
}

describe("independent runtime and admitted-navigation composition", () => {
  it.each(["external Stop", "internal display failure"])(
    "%s fences immediately but awaits the pending startup operation before acknowledging",
    async (cause) => {
      const probeEntered = Promise.withResolvers<void>();
      const probeResult = Promise.withResolvers<boolean>();
      let alive = false;
      let childFailure = () => {};
      const allocations: string[] = [];
      const runtime = new BrowserRuntime(config, {
        prepare: async () => {},
        probe: async (_stage, signal) => {
          expect(signal.aborted).toBe(false);
          probeEntered.resolve();
          return probeResult.promise;
        },
        driver: (spec, failure) => {
          allocations.push(spec.executable);
          childFailure = failure;
          alive = true;
          return {
            started: Promise.resolve(),
            channels: {},
            get closed() {
              return !alive;
            },
            exists() {
              return alive;
            },
            signal() {
              alive = false;
            },
          };
        },
      });
      const startup = runtime.start().then(
        () => "ready",
        () => "refused",
      );
      try {
        await probeEntered.promise;
        if (cause === "internal display failure") childFailure();
        const stop = runtime.stop();
        let stopped = false;
        void stop.then(() => {
          stopped = true;
        });
        expect(runtime.ready).toBe(false);
        expect(runtime.retirement()).toBe(stop);
        expect(alive).toBe(false);
        await settle();
        expect(stopped, "unsettled startup work still belongs to runtime").toBe(false);
        probeResult.resolve(false);
        await stop;
        await runtime.retired;
        expect(await startup).toBe("refused");
        expect(allocations).toEqual(["/usr/bin/Xvfb"]);
      } finally {
        probeResult.resolve(false);
        await runtime.close().catch(() => {});
        await startup;
      }
    },
  );

  it("does not publish a navigation success after request cancellation at the reply boundary", async () => {
    const fixture = await navigationFixture();
    const request = new AbortController();
    fixture.navigate.mockImplementation(async () => {
      request.abort();
    });
    const result = await fixture.navigation
      .navigate(permit, "root-tab", "https://example.test/", request.signal)
      .then(
        () => "success",
        () => "refused",
      );
    expect(fixture.navigate).toHaveBeenCalledTimes(1);
    expect(result, "cancelled navigation must not acknowledge success").toBe("refused");
    await fixture.navigation.close();
    await fixture.control.close();
  });

  it("keeps the navigation slot and close completion until the dispatched operation settles", async () => {
    const fixture = await navigationFixture();
    const result = Promise.withResolvers<void>();
    fixture.navigate.mockImplementation(() => result.promise);
    const navigation = fixture.navigation
      .navigate(permit, "root-tab", "https://example.test/", new AbortController().signal)
      .then(
        () => "success",
        () => "refused",
      );
    let closed = false;
    const closing = fixture.navigation.close().then(() => {
      closed = true;
    });
    try {
      expect(fixture.navigate.mock.calls[0]?.[2]?.aborted).toBe(true);
      await settle();
      expect(closed).toBe(false);
      await expect(
        fixture.navigation.navigate(
          permit,
          "root-tab",
          "https://example.test/",
          new AbortController().signal,
        ),
      ).rejects.toThrow("closed");
      expect(fixture.navigate).toHaveBeenCalledTimes(1);
    } finally {
      result.resolve();
      await closing;
      await fixture.control.close();
    }
    expect(await navigation).toBe("refused");
  });

  it("refuses accessor and proxy permit shapes without evaluating them or dispatching", async () => {
    const fixture = await navigationFixture();
    const getter = vi.fn(() => permit.owner);
    const trap = vi.fn(() => Reflect.ownKeys(permit));
    const accessor = Object.defineProperty({ ...permit }, "owner", {
      get: getter,
      enumerable: true,
    });
    const proxy = new Proxy(permit, { ownKeys: trap });
    for (const malformed of [accessor, proxy]) {
      const result = await fixture.navigation
        .navigate(malformed, "root-tab", "https://example.test/", new AbortController().signal)
        .then(
          () => "success",
          () => "refused",
        );
      expect(result, "malformed permit must not dispatch navigation").toBe("refused");
    }
    expect(getter).not.toHaveBeenCalled();
    expect(trap).not.toHaveBeenCalled();
    expect(fixture.navigate).not.toHaveBeenCalled();
    await fixture.navigation.close();
    await fixture.control.close();
  });

  it("admits one current owned navigation and releases its slot for a subsequent explicit operation", async () => {
    const fixture = await navigationFixture();
    for (const url of ["https://example.test/one", "https://example.test/two"]) {
      await expect(
        fixture.navigation.navigate(permit, "root-tab", url, new AbortController().signal),
      ).resolves.toEqual({ done: true });
    }
    expect(fixture.navigate.mock.calls.map((call) => call[1])).toEqual([
      "https://example.test/one",
      "https://example.test/two",
    ]);
    await fixture.navigation.close();
    await fixture.control.close();
  });
});
