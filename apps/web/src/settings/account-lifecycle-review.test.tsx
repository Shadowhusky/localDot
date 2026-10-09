// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { ChatgptPanel } from "./ChatgptPanel.tsx";
import { type ChatgptControls, useChatgpt } from "./useChatgpt.ts";

const installed = {
  available: true,
  codexVersion: "0.154.0",
  state: "signed_out",
  install: { state: "ready", version: "0.154.0" },
  sandbox: "passed",
};
const absent = {
  available: true,
  codexVersion: "0.154.0",
  state: "unavailable",
  install: { state: "not_installed" },
  sandbox: "unchecked",
};
function view(fetchImpl: typeof fetch) {
  const api = createApi("inert-review", { origin: "https://owned.invalid", fetchImpl });
  let account!: ChatgptControls;
  function Harness() {
    account = useChatgpt(api, true);
    return <ChatgptPanel account={account} />;
  }
  const rendered = render(<Harness />);
  return { ...rendered, current: () => account };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("an acknowledged install cancellation with an actual not-installed reread permits explicit retry", async () => {
  const calls: string[] = [];
  const v = view(async (url, init) => {
    const path = new URL(String(url)).pathname,
      method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    if (method === "GET") return Response.json(absent);
    if (path.endsWith("/install/cancel")) return new Response(null, { status: 204 });
    // The request failed before delivery. The daemon has no installation flight, so its
    // accepted cancel() is a no-op and the exact accepted status remains not_installed.
    throw new Error("inert request never reached the server");
  });
  await act(async () => {});
  expect(v.current().verified).toBe(true);
  await act(async () => {
    await v.current().install();
  });
  expect(v.current().uncertain).toBe(true);
  expect(v.current().canCancelInstall).toBe(true);
  await act(async () => {
    await v.current().cancelInstall();
  });
  expect(v.current().summary?.install).toEqual({ state: "not_installed" });
  expect(v.current().verified).toBe(true);
  expect(v.current().uncertain).toBe(false);
  expect
    .soft(
      v.current().installWatching,
      "a completed Cancel and fresh absent status retire the local watch",
    )
    .toBe(false);
  expect
    .soft(
      screen.queryByRole("button", { name: "Install ChatGPT support" }),
      "explicit retry must become reachable",
    )
    .not.toBeNull();
  const before = calls.length;
  await act(async () => {
    await v.current().install();
  });
  expect
    .soft(calls.slice(before), "an explicit retry is admitted only after reconciliation")
    .toEqual(["POST /api/agent/chatgpt/install"]);
});
it("erases the code and disables explicit open at its deadline while a cached read is pending", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
  const pending = Promise.withResolvers<Response>();
  let reads = 0;
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const material = {
    loginId: "owned-attempt",
    method: "code",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "INERT-REVIEW-CODE",
    startedAt: Date.now() - 600000 + 1500,
  };
  const v = view(async (_url, init) => {
    if (init?.method === "POST") return Response.json(material, { status: 202 });
    return ++reads === 1 ? Response.json(installed) : pending.promise;
  });
  await act(async () => {});
  await act(async () => {
    await v.current().login();
  });
  expect(screen.getByLabelText<HTMLInputElement>("Sign-in code").value).toBe(material.userCode);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(reads).toBe(2);
  expect(v.current().checking).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(501);
  });
  expect
    .soft(
      screen.getByLabelText<HTMLInputElement>("Sign-in code").value,
      "the ten-minute material deadline is independent of a stalled status request",
    )
    .toBe("");
  act(() => v.current().openPage());
  expect.soft(open).not.toHaveBeenCalled();
  v.unmount();
  pending.resolve(Response.json({ ...installed, state: "signing_in", login: material }));
  await act(async () => {});
});
