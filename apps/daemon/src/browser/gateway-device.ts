import type { HitTestResult, InputRequest, InputResult, Point, Target } from "@localdot/protocol";
import { BrowserActionPermit } from "../../../../packages/protocol/src/browser-control.ts";
import { ClockMap } from "../desktopd/clock-map.ts";
import type { NativeDevice } from "../desktopd/registry.ts";
import { type BrowserClient, BrowserClientError, type BrowserScope } from "./client.ts";
import type { ScreenLease } from "./screen-controller.ts";

type Client = Pick<BrowserClient, "clock" | "settle" | "lookup" | "observe" | "input" | "type">;

// One admitted screen action owns this adapter. The action gateway remains responsible for
// authorization, target revalidation, travel and timing; no browser-native operation bypasses it.
export function browserGatewayDevice(options: {
  client: Client;
  permit: BrowserActionPermit;
  tabId: string;
  lease: ScreenLease;
  now(): number;
}): NativeDevice {
  const { client, tabId, lease, now } = options;
  const permit = BrowserActionPermit.parse(options.permit);
  Object.freeze(permit.owner);
  Object.freeze(permit);
  const scale = lease.selection.geometry.scale;
  lease.check();
  if (
    lease.selection.screen !== "browser" ||
    permit.browserCellId !== lease.selection.cellId ||
    (scale !== 1 && scale !== 2)
  )
    throw new BrowserClientError("stale");
  const scope = (signal?: AbortSignal): BrowserScope => {
    const combined = signal ? AbortSignal.any([signal, lease.signal]) : lease.signal;
    const check = () => {
      combined.throwIfAborted();
      lease.check();
    };
    check();
    return { signal: combined, check };
  };
  const toModel = (point: Point): Point => ({ x: point.x / scale, y: point.y / scale });
  const toDevice = (point: Point): Point => ({ x: point.x * scale, y: point.y * scale });
  const target = (value: Target | null): Target | null =>
    value && {
      ...value,
      point: toDevice(value.point),
      ...(value.bbox
        ? {
            bbox: {
              x: value.bbox.x * scale,
              y: value.bbox.y * scale,
              w: value.bbox.w * scale,
              h: value.bbox.h * scale,
            },
          }
        : {}),
    };
  const hit = async (work: Promise<HitTestResult>, owner: BrowserScope): Promise<HitTestResult> => {
    const result = await work;
    owner.check();
    return { ...result, target: target(result.target), window: null };
  };
  const device: NativeDevice["client"] = {
    clock: async () => {
      const owner = scope();
      const result = await client.clock(permit, tabId, owner);
      owner.check();
      return result;
    },
    settle: async (request = {}) => {
      const owner = scope();
      const result = await client.settle(permit, tabId, request, owner);
      owner.check();
      return result;
    },
    observe: async (signal) => {
      const owner = scope(signal);
      const result = await client.observe(permit, tabId, owner);
      owner.check();
      return { ...result.frame, pointer: toDevice(result.frame.pointer) };
    },
    focused: () => {
      const owner = scope();
      return hit(client.lookup(permit, tabId, { kind: "focused" }, owner), owner);
    },
    hitTest: (point) => {
      const owner = scope();
      return hit(
        client.lookup(permit, tabId, { kind: "hitTest", point: toModel(point) }, owner),
        owner,
      );
    },
    find: (request) => {
      const owner = scope();
      return hit(client.lookup(permit, tabId, { kind: "find", ...request }, owner), owner);
    },
    input: async (request, signal, onPress) => {
      const owner = scope(signal);
      if (request.window !== undefined || request.dropWindow !== undefined)
        throw new BrowserClientError("request");
      const input = request.input;
      // A button never stays down past one browser request: drags press and let go inside one.
      if (input.kind === "down" || input.kind === "up")
        throw new Error("Holding a mouse button is not available on the browser screen.");
      const mapped: InputRequest["input"] =
        input.kind === "move"
          ? { ...input, to: toModel(input.to) }
          : input.kind === "drag"
            ? {
                ...input,
                from: toModel(input.from),
                to: toModel(input.to),
                ...(input.path ? { path: input.path.map(toModel) } : {}),
              }
            : input.kind === "click" || input.kind === "scroll"
              ? { ...input, at: toModel(input.at) }
              : input;
      // browserd presses one combo per request: a repeat is that many requests, a hold none.
      if (mapped.kind === "key" && mapped.holdMs)
        throw new Error("Holding keys is not available on the browser screen.");
      const times = mapped.kind === "key" ? (mapped.repeat ?? 1) : 1;
      const once = mapped.kind === "key" ? { kind: "key" as const, combo: mapped.combo } : mapped;
      const results: InputResult[] = [];
      for (let i = 0; i < times; i++) {
        const result = await client.input(permit, tabId, { ...request, input: once }, owner);
        results.push(result);
        owner.check();
        if (times > 1) await onPress?.({ presses: i + 1, pressMono: result.pressMono });
      }
      const [first] = results as [InputResult, ...InputResult[]];
      return { ...first, presses: results.flatMap((r) => r.presses) };
    },
    type: async (request, onProgress, signal) => {
      const owner = scope(signal);
      if (request.window !== undefined) throw new BrowserClientError("request");
      const result = await client.type(permit, tabId, request, owner, async (progress) => {
        owner.check();
        await onProgress(progress);
        owner.check();
      });
      owner.check();
      return result;
    },
  };
  // No background timer may retain an expired action lease or race input on browserd's native pipe.
  return { client: device, clocks: new ClockMap(async () => (await device.clock()).mono, now) };
}
