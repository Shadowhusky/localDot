// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import {
  answerQuestion,
  ControlFailure,
  manualInput,
  returnControl,
  stopTask,
} from "./control-api.ts";

const SESSION = "01JXYZ0000000000000000SESS",
  ID = "01JXYZ00000000000000000001";
const fixture = (fetchImpl: typeof fetch) =>
  createApi("fixture-secret-token", { origin: "https://owned.invalid", fetchImpl });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("sends exact owned IDs with header auth and credentials only to the masked desktop text route", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const api = fixture(fetchImpl),
    signal = new AbortController().signal;
  await answerQuestion(api, SESSION, { askId: ID, option: "A", text: "中文 answer" }, signal);
  await returnControl(api, SESSION, { requestId: ID, note: "Signed in" }, signal);
  const sentinel = `sk-proj-${"s".repeat(80)}`;
  await manualInput(
    api,
    SESSION,
    { requestId: ID, input: { kind: "text", text: sentinel } },
    signal,
  );
  const calls = fetchImpl.mock.calls;
  expect(calls).toHaveLength(3);
  for (const [url, init] of calls) {
    expect(String(url)).not.toContain(api.token);
    expect(init).toMatchObject({
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      headers: { authorization: api.authorization() },
    });
  }
  expect(calls[2]?.[1]?.body).toBe(
    JSON.stringify({ requestId: ID, input: { kind: "text", text: sentinel } }),
  );
  expect(() => answerQuestion(api, SESSION, { askId: ID, text: sentinel }, signal)).toThrow(
    ControlFailure,
  );
  expect(() => returnControl(api, SESSION, { requestId: ID, note: sentinel }, signal)).toThrow(
    ControlFailure,
  );
  expect(() =>
    manualInput(api, "wrong", { requestId: ID, input: { kind: "text", text: "x" } }, signal),
  ).toThrow(ControlFailure);
  expect(fetchImpl).toHaveBeenCalledTimes(3);
});
it("decodes all-false Stop as unconfirmed facts, and refuses unexpected fields/errors instead of trusting202", async () => {
  const value = {
    revoked: true,
    paused: false,
    closed: false,
    stopped: false,
    errors: ["pause: could not confirm completion"],
  };
  const api = fixture(async () => Response.json(value, { status: 202 }));
  expect(await stopTask(api, SESSION, new AbortController().signal)).toEqual(value);
  for (const bad of [
    { ...value, debug: "secret" },
    { ...value, errors: ["raw secret error"] },
    {},
    { ...value, paused: "true" },
  ])
    await expect(
      stopTask(
        fixture(async () => Response.json(bad, { status: 202 })),
        SESSION,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ uncertain: true });
});
it("holds the finite deadline through a response body and cancels it after headers", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const api = fixture(async () => new Response(new ReadableStream({ cancel }), { status: 202 }));
  const work = stopTask(api, SESSION, new AbortController().signal);
  const assertion = expect(work).rejects.toMatchObject({ uncertain: true });
  await vi.advanceTimersByTimeAsync(35_001);
  await assertion;
  expect(cancel).toHaveBeenCalledOnce();
});
it("ignores and cancels a late response when fetch does not honor an ownership abort", async () => {
  const late = Promise.withResolvers<Response>(),
    cancel = vi.fn();
  const fetchImpl = vi.fn<typeof fetch>(async () => late.promise),
    abort = new AbortController();
  const work = returnControl(fixture(fetchImpl), SESSION, { requestId: ID }, abort.signal);
  const assertion = expect(work).rejects.toMatchObject({ uncertain: true });
  abort.abort();
  await assertion;
  late.resolve(new Response(new ReadableStream({ cancel }), { status: 200 }));
  await Promise.resolve();
  await Promise.resolve();
  expect(cancel).toHaveBeenCalledOnce();
  expect(fetchImpl).toHaveBeenCalledOnce();
});
it("bounds actual ack bytes, rejects false length/UTF8, and never reflects refusal bodies", async () => {
  for (const response of [
    new Response("x".repeat(4097), { status: 202 }),
    new Response("{}", { status: 202, headers: { "content-length": "1" } }),
    new Response(new Uint8Array([255]), { status: 202 }),
  ])
    await expect(
      stopTask(
        fixture(async () => response),
        SESSION,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ uncertain: true });
  const error = await returnControl(
    fixture(async () => new Response("private diagnostic", { status: 409 })),
    SESSION,
    { requestId: ID },
    new AbortController().signal,
  ).catch((error: unknown) => error);
  expect(error).toMatchObject({ uncertain: false, status: 409 });
  expect(String(error)).not.toContain("private diagnostic");
});
