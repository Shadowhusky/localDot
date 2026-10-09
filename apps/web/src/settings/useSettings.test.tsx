// @vitest-environment jsdom
import type { AgentSettingsDocument } from "@localdot/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "../lib/api.ts";
import type { ProviderIndex } from "./settings-api.ts";
import { providerFixture } from "./testing.ts";
import { useSettings } from "./useSettings.ts";

afterEach(cleanup);
afterEach(() => {
  Reflect.deleteProperty(document, "hidden");
});
const initial = (): AgentSettingsDocument => ({
  main: { provider: "ollama", model: "local" },
  codexDenyRead: ["/private/fixture"],
  taskBudgetUSD: 2,
});
function server(settings = initial()) {
  const f = {
    settings: structuredClone(settings),
    index: providerFixture(),
    puts: [] as AgentSettingsDocument[],
    calls: [] as string[],
    readIndex: undefined as (() => Promise<ProviderIndex>) | undefined,
    refreshCatalog: undefined as (() => Promise<Response>) | undefined,
    put: undefined as ((data: AgentSettingsDocument) => Promise<Response>) | undefined,
  };
  const api = createApi("fixture", {
    origin: "http://fixture",
    fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname,
        method = init?.method ?? "GET";
      f.calls.push(`${method} ${path}`);
      if (path === "/api/agent/providers")
        return Response.json(f.readIndex ? await f.readIndex() : f.index);
      if (path === "/api/agent/settings" && method === "GET") return Response.json(f.settings);
      if (path === "/api/agent/catalog/refresh" && method === "POST")
        return f.refreshCatalog
          ? f.refreshCatalog()
          : Response.json({ fetchedAt: "2026-10-08T09:00:00Z", providers: 3, skipped: 0 });
      if (path === "/api/agent/settings" && method === "PUT") {
        const data = JSON.parse(String(init?.body)) as AgentSettingsDocument;
        f.puts.push(structuredClone(data));
        if (f.put) return f.put(data);
        f.settings = structuredClone(data);
        return Response.json(data);
      }
      throw new Error("unexpected fixture route");
    },
  });
  return { ...f, api, state: f };
}
function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}
async function opened(f: ReturnType<typeof server>) {
  const view = renderHook(() => useSettings(f.api));
  await waitFor(() => expect(view.result.current.phase).toBe("ready"));
  act(() => view.result.current.show());
  await waitFor(() =>
    expect(view.result.current.draft?.choices.main?.model).toBe(f.state.settings.main?.model),
  );
  return view;
}
describe("explicit configuration save ownership", () => {
  it("refreshes on open, cancels ordinary edits and never autosaves", async () => {
    const f = server(),
      { result } = await opened(f);
    act(() => result.current.change("main", { provider: "ollama", model: "edited" }));
    expect(result.current.dirty).toBe(true);
    expect(f.state.puts).toEqual([]);
    act(() => result.current.close());
    expect(result.current.draft).toBeNull();
    f.state.settings.main = { provider: "ollama", model: "changed-elsewhere" };
    act(() => result.current.show());
    await waitFor(() =>
      expect(result.current.draft?.choices.main?.model).toBe("changed-elsewhere"),
    );
    expect(result.current.dirty).toBe(false);
    expect(f.state.puts).toEqual([]);
  });
  it("locks before preflight and sends one complete document, retaining unrelated fields", async () => {
    const f = server(),
      { result } = await opened(f);
    act(() => result.current.change("main", { provider: "ollama", model: "edited" }));
    const held = Promise.withResolvers<ProviderIndex>();
    f.state.readIndex = () => held.promise;
    let first!: Promise<void>, second!: Promise<void>;
    act(() => {
      first = result.current.save();
      second = result.current.save();
    });
    expect(result.current.busy).toBe(true);
    expect(f.state.puts).toEqual([]);
    await act(async () => {
      held.resolve(f.state.index);
      await Promise.all([first, second]);
    });
    expect(f.state.puts).toEqual([{ ...initial(), main: { provider: "ollama", model: "edited" } }]);
    expect(result.current.saved).toEqual(f.state.puts[0]);
    expect(result.current.dirty).toBe(false);
  });
  it("checks fresh metadata before PUT and refuses a key deleted after picker load", async () => {
    const f = server({
      main: { provider: "anthropic", model: "claude-sonnet-5-5", key: "anthropic" },
    });
    const { result } = await opened(f);
    act(() => result.current.spending({ on: true, task: "3", day: "" }));
    f.state.index.keys = [];
    await act(async () => {
      await result.current.save();
    });
    expect(f.state.puts).toEqual([]);
    expect(result.current.validation?.join(" ")).toContain("stored key");
    expect(result.current.error).toBeNull();
    expect(result.current.draft?.spending.task).toBe("3");
    expect(result.current.dirty).toBe(true);
  });
  it("does not send the captured configuration when the draft changes during preflight", async () => {
    const f = server(),
      { result } = await opened(f);
    act(() => result.current.change("main", { provider: "ollama", model: "first" }));
    const held = Promise.withResolvers<ProviderIndex>();
    f.state.readIndex = () => held.promise;
    let saving!: Promise<void>;
    act(() => {
      saving = result.current.save();
    });
    act(() => result.current.change("main", { provider: "ollama", model: "second" }));
    await act(async () => {
      held.resolve(f.state.index);
      await saving;
    });
    expect(f.state.puts).toEqual([]);
    expect(result.current.draft?.choices.main?.model).toBe("second");
  });
  it("keeps newer edits when an old PUT finishes and requires reconciliation before another save", async () => {
    const f = server(),
      { result } = await opened(f);
    const held = Promise.withResolvers<Response>();
    f.state.put = () => held.promise;
    act(() => result.current.change("main", { provider: "ollama", model: "first" }));
    let saving!: Promise<void>;
    act(() => {
      saving = result.current.save();
    });
    await waitFor(() => expect(f.state.puts).toHaveLength(1));
    act(() => result.current.change("main", { provider: "ollama", model: "second" }));
    await act(async () => {
      held.resolve(Response.json(f.state.puts[0]));
      await saving;
    });
    expect(result.current.draft?.choices.main?.model).toBe("second");
    expect(result.current.uncertain).toBe(true);
    expect(result.current.mainReady).toBe(false);
    await act(async () => {
      await result.current.save();
    });
    expect(f.state.puts).toHaveLength(1);
  });
  it("cannot overwrite a reopened draft with an old save response", async () => {
    const f = server(),
      { result } = await opened(f),
      held = Promise.withResolvers<Response>();
    f.state.put = () => held.promise;
    act(() => result.current.change("main", { provider: "ollama", model: "old" }));
    let saving!: Promise<void>;
    act(() => {
      saving = result.current.save();
    });
    await waitFor(() => expect(f.state.puts).toHaveLength(1));
    act(() => {
      result.current.close();
      result.current.show();
    });
    await waitFor(() => expect(result.current.draft?.choices.main?.model).toBe("local"));
    act(() => result.current.change("main", { provider: "ollama", model: "reopened" }));
    await act(async () => {
      held.resolve(Response.json(f.state.puts[0]));
      await saving;
    });
    expect(result.current.draft?.choices.main?.model).toBe("reopened");
    expect(result.current.uncertain).toBe(true);
  });
  it("retains edits after a verified refusal and blocks automatic retry after a lost reply", async () => {
    const f = server(),
      { result } = await opened(f);
    act(() => result.current.spending({ on: true, task: "3", day: "" }));
    f.state.put = async () => new Response("private-refusal", { status: 400 });
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.draft?.spending.task).toBe("3");
    expect(result.current.uncertain).toBe(false);
    expect(result.current.error).not.toContain("private-refusal");
    f.state.put = async (data) => {
      f.state.settings = data;
      throw new Error("private-lost-reply");
    };
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.uncertain).toBe(true);
    await act(async () => {
      await result.current.save();
    });
    expect(f.state.puts).toHaveLength(2);
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.uncertain).toBe(false));
    expect(result.current.saved?.taskBudgetUSD).toBe(3);
    expect(f.state.puts).toHaveLength(2);
  });
  it("fences interrupted writes until pageshow and an explicit reload", async () => {
    const f = server(),
      { result } = await opened(f),
      held = Promise.withResolvers<Response>();
    f.state.put = () => held.promise;
    act(() => result.current.spending({ on: true, task: "3", day: "" }));
    let saving!: Promise<void>;
    act(() => {
      saving = result.current.save();
    });
    await waitFor(() => expect(f.state.puts).toHaveLength(1));
    act(() => window.dispatchEvent(new Event("pagehide")));
    await act(async () => {
      held.resolve(Response.json(f.state.puts[0]));
      await saving;
    });
    expect(result.current.uncertain).toBe(true);
    expect(result.current.mainReady).toBe(false);
    act(() => result.current.reload());
    expect(result.current.phase).toBe("error");
    act(() => {
      window.dispatchEvent(new Event("pageshow"));
      result.current.reload();
    });
    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(result.current.uncertain).toBe(false);
  });
  it("keeps edits saveable after the page is hidden and shown again, then saves once", async () => {
    const f = server(),
      { result } = await opened(f);
    act(() => result.current.change("main", { provider: "ollama", model: "edited" }));
    act(() => setHidden(true));
    expect(result.current.saveEnabled).toBe(false);
    act(() => setHidden(false));
    await waitFor(() => expect(result.current.saveEnabled).toBe(true));
    expect(result.current.draft?.choices.main?.model).toBe("edited");
    expect(result.current.dirty).toBe(true);
    expect(result.current.error).toBeNull();
    await act(async () => {
      await result.current.save();
    });
    expect(f.state.puts).toEqual([{ ...initial(), main: { provider: "ollama", model: "edited" } }]);
  });
  it("restores readiness after a background while Settings is closed", async () => {
    const f = server(),
      view = renderHook(() => useSettings(f.api));
    await waitFor(() => expect(view.result.current.mainReady).toBe(true));
    act(() => setHidden(true));
    expect(view.result.current.mainReady).toBe(false);
    act(() => setHidden(false));
    await waitFor(() => expect(view.result.current.mainReady).toBe(true));
  });
  it("keeps edits when the return read fails and lets Try again recover them", async () => {
    const f = server(),
      { result } = await opened(f);
    act(() => result.current.change("main", { provider: "ollama", model: "edited" }));
    f.state.readIndex = async () => {
      throw new Error("private-offline");
    };
    act(() => setHidden(true));
    act(() => setHidden(false));
    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.error).toContain("Your edits are kept");
    expect(result.current.draft?.choices.main?.model).toBe("edited");
    f.state.readIndex = undefined;
    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => expect(result.current.saveEnabled).toBe(true));
    expect(result.current.draft?.choices.main?.model).toBe("edited");
    expect(f.state.calls).not.toContain("POST /api/agent/catalog/refresh");
  });
  it("retries the catalog refresh, not a read, after a failed refresh", async () => {
    const f = server(),
      { result } = await opened(f);
    f.state.refreshCatalog = async () => new Response("down", { status: 503 });
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.phase).toBe("error");
    expect(result.current.error).toContain("could not be refreshed");
    f.state.refreshCatalog = undefined;
    await act(async () => {
      await result.current.refresh();
    });
    expect(f.state.calls.filter((call) => call === "POST /api/agent/catalog/refresh")).toHaveLength(
      2,
    );
    expect(result.current.phase).toBe("ready");
    expect(result.current.error).toBeNull();
  });
  it("ignores an old account's save and metadata responses after API replacement", async () => {
    const first = server(),
      next = server({ main: { provider: "ollama", model: "new-account" } });
    const view = renderHook(({ api }) => useSettings(api), { initialProps: { api: first.api } });
    await waitFor(() => expect(view.result.current.phase).toBe("ready"));
    act(() => view.result.current.show());
    await waitFor(() => expect(view.result.current.draft).not.toBeNull());
    act(() => view.result.current.spending({ on: true, task: "3", day: "" }));
    const held = Promise.withResolvers<Response>();
    first.state.put = () => held.promise;
    let saving!: Promise<void>;
    act(() => {
      saving = view.result.current.save();
    });
    await waitFor(() => expect(first.state.puts).toHaveLength(1));
    view.rerender({ api: next.api });
    await waitFor(() => expect(view.result.current.saved?.main?.model).toBe("new-account"));
    await act(async () => {
      held.resolve(Response.json(first.state.puts[0]));
      await saving;
    });
    expect(view.result.current.saved?.main?.model).toBe("new-account");
    expect(view.result.current.uncertain).toBe(false);
    expect(next.state.puts).toEqual([]);
  });
  it("selects only one newly added matching binding and rejects changed or ambiguous key contexts", async () => {
    const f = server({ main: { provider: "anthropic", model: "claude-sonnet-5-5" } }),
      { result } = await opened(f);
    const key = {
      id: "new-key",
      kind: "llm" as const,
      provider: "anthropic",
      createdAt: "t",
      updatedAt: "t",
    };
    let context = result.current.captureKey("main", "anthropic");
    f.state.index.keys.push({ id: key.id, provider: key.provider });
    await act(async () => {
      await result.current.keySaved(context, key);
    });
    expect(result.current.draft?.choices.main?.key).toBe("new-key");
    context = result.current.captureKey("main", "anthropic");
    act(() => result.current.change("main", { provider: "ollama", model: "changed" }));
    await act(async () => {
      await result.current.keySaved(context, { ...key, id: "another" });
    });
    expect(result.current.draft?.choices.main).toEqual({ provider: "ollama", model: "changed" });
    act(() => result.current.change("main", { provider: "anthropic", model: "claude-sonnet-5-5" }));
    context = result.current.captureKey("main", "anthropic");
    f.state.index.keys.push(
      { id: "another", provider: "anthropic" },
      { id: "ambiguous", provider: "anthropic" },
    );
    await act(async () => {
      await result.current.keySaved(context, { ...key, id: "another" });
    });
    expect(result.current.draft?.choices.main?.key).toBeUndefined();
  });
  it("binds a key saved after switching apps to copy it", async () => {
    const f = server({ main: { provider: "anthropic", model: "claude-sonnet-5-5" } }),
      { result } = await opened(f);
    const context = result.current.captureKey("main", "anthropic");
    act(() => setHidden(true));
    act(() => setHidden(false));
    await waitFor(() => expect(result.current.phase).toBe("ready"));
    f.state.index.keys.push({ id: "copied", provider: "anthropic" });
    await act(async () => {
      await result.current.keySaved(context, { ...storedKey, id: "copied" });
    });
    expect(result.current.index?.keys.map((key) => key.id)).toContain("copied");
    expect(result.current.draft?.choices.main?.key).toBe("copied");
    expect(result.current.saveEnabled).toBe(true);
  });
  it("lists a key saved after other edits without binding it", async () => {
    const f = server({ main: { provider: "anthropic", model: "claude-sonnet-5-5" } }),
      { result } = await opened(f);
    const context = result.current.captureKey("main", "anthropic");
    act(() => result.current.spending({ on: true, task: "3", day: "" }));
    f.state.index.keys.push({ id: "later", provider: "anthropic" });
    await act(async () => {
      await result.current.keySaved(context, { ...storedKey, id: "later" });
    });
    expect(result.current.index?.keys.map((key) => key.id)).toContain("later");
    expect(result.current.draft?.choices.main?.key).toBeUndefined();
  });
});
const storedKey = {
  id: "",
  kind: "llm" as const,
  provider: "anthropic",
  createdAt: "t",
  updatedAt: "t",
};
describe("switching the main model from the composer", () => {
  const onKeys = (): AgentSettingsDocument => ({
    main: { provider: "anthropic", model: "claude-sonnet-5-5", key: "anthropic" },
    fast: { provider: "openai", model: "gpt-6-luna", key: "openai" },
    codexDenyRead: ["/private/fixture"],
    taskBudgetUSD: 2,
  });
  async function ready(f: ReturnType<typeof server>) {
    const view = renderHook(() => useSettings(f.api));
    await waitFor(() => expect(view.result.current.phase).toBe("ready"));
    return view;
  }

  it("saves the whole document with only the main model changed, checked as Settings checks it", async () => {
    const f = server(onKeys()),
      { result } = await ready(f);
    let saved = false;
    await act(async () => {
      saved = await result.current.chooseMain({
        provider: "openai",
        model: "gpt-6-luna",
        key: "openai",
      });
    });
    expect(saved).toBe(true);
    expect(f.state.puts).toEqual([
      { ...onKeys(), main: { provider: "openai", model: "gpt-6-luna", key: "openai" } },
    ]);
    expect(result.current.saved?.main?.model).toBe("gpt-6-luna");
  });

  it("refuses a model Settings would refuse, and saves nothing", async () => {
    const f = server(onKeys()),
      { result } = await ready(f);
    let saved = true;
    await act(async () => {
      saved = await result.current.chooseMain({
        provider: "openai",
        model: "gpt-6-luna",
        key: "gone",
      });
    });
    expect(saved).toBe(false);
    expect(f.state.puts).toEqual([]);
  });

  it("leaves the choosing to Settings while it is open", async () => {
    const f = server(onKeys()),
      { result } = await opened(f);
    let saved = true;
    await act(async () => {
      saved = await result.current.chooseMain({
        provider: "openai",
        model: "gpt-6-luna",
        key: "openai",
      });
    });
    expect(saved).toBe(false);
    expect(f.state.puts).toEqual([]);
  });

  it("reads the saved settings back when a save's reply is lost", async () => {
    const f = server(onKeys()),
      { result } = await ready(f);
    f.state.put = async (data) => {
      f.state.settings = structuredClone(data);
      return new Response("lost", { status: 502 });
    };
    let saved = true;
    await act(async () => {
      saved = await result.current.chooseMain({
        provider: "openai",
        model: "gpt-6-luna",
        key: "openai",
      });
    });
    expect(saved).toBe(false);
    await waitFor(() => expect(result.current.saved?.main?.model).toBe("gpt-6-luna"));
  });
});
