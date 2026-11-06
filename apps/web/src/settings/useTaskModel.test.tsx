// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../lib/api.ts";
import { useTaskModel } from "./useTaskModel.ts";

const TASK = "01JXYZ0000000000000000SESS";
const OTHER = "01JXYZ0000000000000000OTHR";
const OPUS = { provider: "anthropic", model: "claude-opus-5-5", key: "anthropic" };
const LUNA = { provider: "openai", model: "gpt-6-luna", key: "openai" };

function api(stored: Record<string, unknown> = {}) {
  const put = vi.fn(async (path: string, body: unknown) => {
    stored[path] = body;
    return { choice: body };
  });
  const get = vi.fn(async (path: string) => ({ choice: stored[path] ?? null }));
  return { api: { get, put } as unknown as ApiClient, put, get };
}
const at = (id: string) => `/api/agent/sessions/${id}/model`;

afterEach(cleanup);
beforeEach(() => window.localStorage.clear());

describe("a task's own model", () => {
  it("reads a task's choice, and is empty for one with none, which then runs on the default", async () => {
    const f = api({ [at(TASK)]: OPUS });
    const view = renderHook(({ id }) => useTaskModel(f.api, id), {
      initialProps: { id: TASK as string | null },
    });
    await waitFor(() => expect(view.result.current.choice).toEqual(OPUS));
    expect(view.result.current.ref).toEqual(OPUS);
    view.rerender({ id: OTHER });
    expect(view.result.current.choice).toBeUndefined();
    await waitFor(() => expect(f.get).toHaveBeenCalledWith(at(OTHER), expect.anything()));
    expect(view.result.current.ref).toBeUndefined();
  });

  it("saves a choice with the task alone, and goes back when it can't", async () => {
    const f = api({ [at(TASK)]: OPUS });
    const view = renderHook(() => useTaskModel(f.api, TASK));
    await waitFor(() => expect(view.result.current.choice).toEqual(OPUS));
    await act(async () => {
      expect(await view.result.current.choose(LUNA)).toBe(true);
    });
    expect(f.put).toHaveBeenCalledWith(at(TASK), LUNA);
    expect(view.result.current.choice).toEqual(LUNA);
    f.put.mockRejectedValueOnce(new Error("no"));
    await act(async () => {
      expect(await view.result.current.choose(OPUS)).toBe(false);
    });
    expect(view.result.current.choice).toEqual(LUNA);
  });

  it("keeps a choice made before there is a task, over a reload, until its first message", async () => {
    const f = api();
    const first = renderHook(() => useTaskModel(f.api, null));
    await act(async () => {
      await first.result.current.choose(OPUS);
    });
    expect(first.result.current.ref).toEqual(OPUS);
    expect(f.put).not.toHaveBeenCalled();
    first.unmount();
    const reloaded = renderHook(({ id }) => useTaskModel(f.api, id), {
      initialProps: { id: null as string | null },
    });
    expect(reloaded.result.current.choice).toEqual(OPUS);
    reloaded.rerender({ id: TASK });
    await waitFor(() => expect(window.localStorage.length).toBe(0));
  });
});
