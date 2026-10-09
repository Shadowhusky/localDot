// @vitest-environment jsdom
import { qualityMessage } from "@localdot/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { fakeChromium, playInClient } from "../testing/fake-chromium.ts";
import { closeStreams, holdStream, KEEP_MS, STALE_MS } from "./live-stream.ts";

const CELL = "01JXYZ0000000000000000ABCD";
const ticket = (n: number) => `/cells/${CELL}/desktop/${String(n).padStart(22, "T")}/`;
const clients = () => [...document.querySelectorAll<HTMLIFrameElement>("iframe.desktop-frame")];

// The daemon answers the n-th ticket request with `answer(n)`.
function daemon(answer: (n: number) => Response) {
  let minted = 0;
  const fetchImpl = (async () => answer(++minted)) as typeof fetch;
  return { api: createApi("a".repeat(43), { fetchImpl }), minted: () => minted };
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
});
afterEach(() => {
  closeStreams();
  vi.useRealTimers();
});

it("lets a stream go at once when its computer stops, or a minute after its stage leaves", async () => {
  const { api } = daemon((n) => Response.json({ path: ticket(n) }));
  const target = { api, cellId: CELL, surface: "desktop" as const };
  const first = holdStream(target, () => [CELL]);
  await vi.advanceTimersByTimeAsync(0);
  expect(clients()).toHaveLength(1);
  first.release(KEEP_MS);
  await vi.advanceTimersByTimeAsync(KEEP_MS - 1);
  const again = holdStream(target, () => [CELL]);
  expect(again.stream).toBe(first.stream);
  const other = holdStream(target, () => [CELL]);
  await vi.advanceTimersByTimeAsync(KEEP_MS * 2);
  expect(clients()).toHaveLength(1);
  again.release(0);
  expect(clients()).toHaveLength(1);
  other.release(0);
  expect(clients()).toHaveLength(0);
  expect(holdStream(target, () => [CELL]).stream).not.toBe(first.stream);
});

it("gives a client that keeps failing to load longer each time, instead of reloading every 10 s", async () => {
  const { api, minted } = daemon((n) => Response.json({ path: ticket(n) }));
  const { stream } = holdStream({ api, cellId: CELL, surface: "desktop" }, () => [CELL]);
  stream.connect(() => {});
  await vi.advanceTimersByTimeAsync(250);
  expect(minted()).toBe(1);
  await vi.advanceTimersByTimeAsync(STALE_MS);
  expect(minted()).toBe(2);
  expect(clients().map((frame) => frame.getAttribute("src"))).toEqual([`${ticket(2)}#shared`]);
  await vi.advanceTimersByTimeAsync(STALE_MS);
  expect(minted()).toBe(2);
  await vi.advanceTimersByTimeAsync(STALE_MS);
  expect(minted()).toBe(3);
});

it("asks again for a ticket the daemon refused, less often each time", async () => {
  const { api, minted } = daemon(() => new Response("not ready", { status: 409 }));
  const { stream } = holdStream({ api, cellId: CELL, surface: "desktop" }, () => [CELL]);
  stream.connect(() => {});
  await vi.advanceTimersByTimeAsync(250);
  expect(minted()).toBe(1);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(minted()).toBe(2);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(minted()).toBe(2);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(minted()).toBe(3);
  expect(clients()).toHaveLength(0);
});

it("tells its relay each second what this viewer can take, and that a hidden page asks for nothing", async () => {
  const restore = fakeChromium();
  let visibility: DocumentVisibilityState = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  try {
    const paths: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const { pathname } = new URL(String(input));
      paths.push(pathname);
      return pathname === "/healthz" ? new Response("ok") : Response.json({ path: ticket(1) });
    }) as typeof fetch;
    const api = createApi("a".repeat(43), { fetchImpl });
    const { stream } = holdStream({ api, cellId: CELL, surface: "desktop" }, () => [CELL]);
    stream.connect(() => {});
    await vi.advanceTimersByTimeAsync(250);
    const [frame] = clients();
    if (!frame) throw new Error("no client");
    playInClient(frame, "track-1");
    const send = vi.fn();
    Object.assign(frame.contentWindow as object, { selkiesTransport: { readyState: 1, send } });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(send).toHaveBeenCalledWith(qualityMessage({ visible: true, framerate: 60, crf: 25 }));
    expect(paths.filter((path) => path === "/healthz").length).toBeGreaterThan(0);

    send.mockClear();
    visibility = "hidden";
    await vi.advanceTimersByTimeAsync(250);
    expect(send.mock.calls).toEqual([[qualityMessage({ visible: false })]]);
  } finally {
    Reflect.deleteProperty(document, "visibilityState");
    restore();
  }
});
