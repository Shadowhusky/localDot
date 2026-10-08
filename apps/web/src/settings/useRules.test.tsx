// @vitest-environment jsdom
import type { AutonomyRule } from "@localdot/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { useRules } from "./useRules.ts";

afterEach(cleanup);

const ORIGIN = "https://owned.invalid";
const rule = (id: string): AutonomyRule => ({
  id,
  behavior: "act",
  actionClass: "send",
  scope: "site",
  site: "https://mail.example.test",
  label: "On mail.example.test",
  createdAt: 1,
  createdFrom: "01J00000000000000000000003",
});
const ONE = rule("01J00000000000000000000010"),
  TWO = rule("01J00000000000000000000011");
type Reply = { status: number; body?: unknown };
function setup(replies: Reply[], open = true) {
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    const reply = replies.shift() ?? { status: 500 };
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
    });
  });
  const api = createApi("fixture", { origin: ORIGIN, fetchImpl });
  const hook = renderHook((visible: boolean) => useRules(api, visible), { initialProps: open });
  const call = (n: number) => {
    const [url, init] = fetchImpl.mock.calls[n] ?? [];
    return [String(url).replace(ORIGIN, ""), init?.method ?? "GET"];
  };
  return { fetchImpl, hook, call };
}

it("reads the list only while Settings is open", async () => {
  const { fetchImpl, hook, call } = setup([{ status: 200, body: { rules: [ONE] } }], false);
  expect(fetchImpl).not.toHaveBeenCalled();
  hook.rerender(true);
  await waitFor(() => expect(hook.result.current.phase).toBe("ready"));
  expect(call(0)).toEqual(["/api/agent/rules", "GET"]);
  expect(hook.result.current.rules).toEqual([ONE]);
  expect(hook.result.current.unreadable).toBeNull();
});

it("passes on an unreadable file and treats a malformed reply as an error", async () => {
  const unreadable = "Saved Always allow choices could not be read, so none are in use.";
  const { hook } = setup([
    { status: 200, body: { rules: [], error: unreadable } },
    { status: 200, body: { rules: [{ ...ONE, behavior: "ask" }] } },
  ]);
  await waitFor(() => expect(hook.result.current.unreadable).toBe(unreadable));
  act(() => hook.result.current.reload());
  await waitFor(() => expect(hook.result.current.phase).toBe("error"));
  expect(hook.result.current.rules).toEqual([]);
});

it("removes a rule, counts one already gone as removed, and marks a failure", async () => {
  const { hook, call } = setup([
    { status: 200, body: { rules: [ONE, TWO] } },
    { status: 500 },
    { status: 204 },
    { status: 404 },
  ]);
  await waitFor(() => expect(hook.result.current.rules).toHaveLength(2));
  await act(async () => hook.result.current.remove(ONE.id));
  await waitFor(() => expect(hook.result.current.failed).toBe(ONE.id));
  expect(call(1)).toEqual([`/api/agent/rules/${ONE.id}`, "DELETE"]);
  expect(hook.result.current.rules).toEqual([ONE, TWO]);
  await act(async () => hook.result.current.remove(ONE.id));
  await waitFor(() => expect(hook.result.current.rules).toEqual([TWO]));
  expect(hook.result.current.failed).toBeNull();
  await act(async () => hook.result.current.remove(TWO.id));
  await waitFor(() => expect(hook.result.current.rules).toEqual([]));
  expect(hook.result.current.removing).toBeNull();
});

it("sets an unreadable file aside, then reads the list again", async () => {
  const { hook, call } = setup([
    { status: 200, body: { rules: [], error: "Saved Always allow choices could not be read." } },
    { status: 204 },
    { status: 200, body: { rules: [] } },
  ]);
  await waitFor(() => expect(hook.result.current.unreadable).not.toBeNull());
  await act(async () => hook.result.current.reset());
  await waitFor(() => expect(hook.result.current.unreadable).toBeNull());
  expect(call(1)).toEqual(["/api/agent/rules/reset", "POST"]);
  expect(call(2)).toEqual(["/api/agent/rules", "GET"]);
});

it("says when Start over failed, and forgets it once it works", async () => {
  const unreadable = "Saved Always allow choices could not be read, so none are in use.";
  const { hook, call } = setup([
    { status: 200, body: { rules: [], error: unreadable } },
    { status: 500 },
    { status: 200, body: { rules: [], error: unreadable } },
    { status: 204 },
    { status: 200, body: { rules: [] } },
  ]);
  await waitFor(() => expect(hook.result.current.unreadable).toBe(unreadable));
  await act(async () => hook.result.current.reset());
  await waitFor(() => expect(hook.result.current.resetFailed).toBe(true));
  await waitFor(() => expect(hook.result.current.phase).toBe("ready"));
  expect(call(2)).toEqual(["/api/agent/rules", "GET"]);
  expect(hook.result.current.unreadable).toBe(unreadable);
  await act(async () => hook.result.current.reset());
  await waitFor(() => expect(hook.result.current.unreadable).toBeNull());
  expect(hook.result.current.resetFailed).toBe(false);
});
