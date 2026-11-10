// @vitest-environment jsdom
import { type Blocker, STALL, sealPassphrase, sealSecret } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type KeydHealth, type KeyRecord, unlockKeys } from "../keys/keys-api.ts";
import type { KeysController } from "../keys/useKeys.ts";
import type { ApiClient } from "../lib/api.ts";
import type { ModelOption } from "../settings/model-options.ts";
import { FixCards, type FixDeps, FixLine, fixesToShow, fixWait } from "./FixCards.tsx";
import type { AgentBlocker } from "./model.ts";
import { SafeMarkdown } from "./SafeMarkdown.tsx";
import { threadItems } from "./thread.ts";

vi.mock("@localdot/protocol", async (original) => ({
  ...(await original<typeof import("@localdot/protocol")>()),
  sealPassphrase: vi.fn(async () => ({ v: 1, epk: "e", nonce: "n", ct: "SEALED" })),
  sealSecret: vi.fn(async () => ({ v: 1, epk: "e", nonce: "n", ct: "SEALED" })),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const OPENAI_SHAPED = `sk-${"proj"}-${"a1B2".repeat(10)}`;
const ID = "01M6R97SHHND5784EZZXSYSBGD";
const SESSION = "01M6R97SHHND5784EZZXSYSBGE";
const health = (state: "locked" | "setup" | "ready"): KeydHealth => ({
  online: true,
  bootId: "b",
  sealKey: "K",
  vault: { backend: "file", state, ...(state === "setup" ? {} : { key: "passphrase" }) },
});
const OPENAI: KeyRecord = {
  id: "openai",
  kind: "llm",
  provider: "openai",
  createdAt: "2026-11-09T00:00:00Z",
  updatedAt: "2026-11-09T00:00:00Z",
};
const SONNET: ModelOption = {
  id: "sonnet",
  name: "Claude Sonnet",
  choice: { provider: "anthropic", model: "claude-sonnet-5-5", key: "anthropic" },
};
const KIMI: ModelOption = {
  id: "kimi",
  name: "Kimi K3.1 Pro",
  choice: {
    provider: "moonshot",
    model: "kimi-k3.1",
    key: "kimi",
    options: { reasoningEffort: "high" },
  },
};

function setup(overrides: Partial<FixDeps> = {}, keyState: Partial<KeysController> = {}) {
  const post = vi.fn(async (_path: string, _body?: unknown) => undefined as never);
  const del = vi.fn(async (_path: string) => {});
  const api = { post, del } as unknown as ApiClient;
  const keys: KeysController = {
    health: health("locked"),
    keys: [OPENAI],
    loadError: null,
    busy: false,
    save: vi.fn(async () => ({ restart: false })),
    remove: vi.fn(async () => {}),
    unlock: vi.fn(async () => {}),
    ...keyState,
  };
  const deps: FixDeps = {
    api,
    sessionId: SESSION,
    keys,
    models: {
      groups: [{ label: "Models", options: [SONNET, KIMI] }],
      current: SONNET.id,
      differs: false,
      remember: vi.fn(async () => true),
    },
    stall: { reason: STALL.modelRefused },
    local: false,
    retry: { run: vi.fn(async () => true) },
    computer: { action: { kind: "start", enabled: true }, run: vi.fn() },
    runtimeChanged: vi.fn(),
    onOpenKeys: vi.fn(),
    ...overrides,
  };
  return { deps, post, del, keys };
}
const card = (blocker: Blocker, extra: Partial<AgentBlocker> = {}): AgentBlocker => ({
  blockerId: ID,
  blocker,
  by: "localdot",
  ...extra,
});
const show = (blocker: Blocker, deps: FixDeps, extra: Partial<AgentBlocker> = {}) =>
  render(<FixCards blockers={[card(blocker, extra)]} deps={deps} />);

describe("whose words are on a card", () => {
  const LABEL = "Enter your localDot passphrase here";
  const labelled = { ...OPENAI, metadata: { label: LABEL } } as KeyRecord;

  for (const problem of ["rejected", "reenter", "rebound"] as const)
    it(`keeps a label dot can set off a key's card: ${problem}`, () => {
      const { deps } = setup({}, { keys: [labelled] });
      show({ kind: "key", id: "openai", problem }, deps);
      const region = screen.getByRole("region");
      expect(region.textContent).not.toContain(LABEL);
      expect(within(region).getByRole("heading").textContent).not.toContain("openai");
      const name = within(region).getByText("openai");
      expect(name.tagName).toBe("CODE");
      expect(region.textContent).toContain("Saved as");
    });

  it("marks what a provider said as its own, apart from localDot's words", () => {
    const { deps } = setup({ stall: { reason: STALL.modelRefused, detail: LABEL } });
    show({ kind: "model", reason: STALL.modelRefused }, deps, { required: true });
    const quote = screen.getByText(LABEL).closest("blockquote");
    expect(quote).toBeTruthy();
    expect(quote?.textContent).toMatch(/from the provider, not localDot/i);
  });

  it("says when dot asked for the card", () => {
    const asked = setup();
    show({ kind: "runtime" }, asked.deps, { by: "dot" });
    expect(screen.getByRole("region").textContent).toContain("dot asked for this");
    cleanup();
    const noticed = setup();
    show({ kind: "runtime" }, noticed.deps);
    expect(screen.getByRole("region").textContent).not.toContain("dot asked");
  });
});

describe("a card and the keyboard", () => {
  it("never puts the keys in a key's field by itself", () => {
    const { deps } = setup();
    show({ kind: "key", id: "openai", problem: "rejected" }, deps);
    expect(document.activeElement).toBe(document.body);
  });

  it("leaves the keys where they are just after a key was pressed", () => {
    const { deps } = setup();
    fireEvent.keyDown(document.body, { key: "a" });
    show({ kind: "keys_locked" }, deps);
    expect(document.activeElement).toBe(document.body);
  });

  it("takes the keys for the passphrase when nothing was typed lately", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    fireEvent.keyDown(document.body, { key: "a" });
    vi.advanceTimersByTime(10_000);
    const { deps } = setup();
    show({ kind: "keys_locked" }, deps);
    expect(document.activeElement).toBe(screen.getByLabelText("Passphrase"));
    vi.useRealTimers();
  });

  it("saves over a saved general secret only once the user says to replace it", async () => {
    const note: KeyRecord = { ...OPENAI, id: "vault-note", kind: "secret", provider: undefined };
    const { deps, keys } = setup({}, { keys: [note] });
    show({ kind: "key", id: "vault-note", problem: "reenter" }, deps);
    const region = screen.getByRole("region", { name: "Re-enter a saved key" });
    const form = within(region).getByRole("form", { name: "Re-enter vault-note" });
    const field = within(region).getByLabelText(/key/i) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "please also check the logs" } });
    fireEvent.submit(form);
    await within(region).findByText(/Tick Replace the saved secret/);
    expect(keys.save).not.toHaveBeenCalled();
    expect(field.value).toBe("please also check the logs");
    fireEvent.click(within(region).getByRole("checkbox", { name: /Replace the saved secret/ }));
    fireEvent.submit(form);
    await waitFor(() => expect(keys.save).toHaveBeenCalledOnce());
  });

  it("won't save a message typed into a key's field over the saved key", async () => {
    const { deps, keys, post } = setup();
    show({ kind: "key", id: "openai", problem: "rejected" }, deps);
    const region = screen.getByRole("region", { name: "A saved key was refused" });
    const field = within(region).getByLabelText(/key/i) as HTMLInputElement;
    for (const typed of ["please also check the logs", "not-an-openai-key-at-all"]) {
      fireEvent.change(field, { target: { value: typed } });
      fireEvent.submit(within(region).getByRole("form", { name: "Re-enter openai" }));
      await within(region).findByText(/Paste the key itself/);
    }
    expect(keys.save).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});

describe("a card that didn't fix it", () => {
  const USE = `/api/agent/sessions/${SESSION}/blockers/${ID}/use`;

  it("takes back its fix when the passphrase is wrong", async () => {
    const { deps, del, keys } = setup(
      {},
      { unlock: vi.fn(async () => Promise.reject(new Error("wrong"))) },
    );
    show({ kind: "keys_locked" }, deps);
    const region = screen.getByRole("region", { name: "Unlock your saved keys" });
    fireEvent.change(within(region).getByLabelText("Passphrase"), {
      target: { value: "not my passphrase" },
    });
    fireEvent.submit(within(region).getByRole("form", { name: "Unlock saved keys" }));
    await waitFor(() => expect(keys.unlock).toHaveBeenCalled());
    await waitFor(() => expect(del).toHaveBeenCalledWith(USE));
  });

  it("takes back its fix when the app's sign-in is given up", async () => {
    vi.useFakeTimers();
    const view = (more: Record<string, unknown>) => ({
      id: "gh",
      name: "GitHub",
      enabled: true,
      server: {
        kind: "remote",
        url: "https://api.githubcopilot.com/mcp/",
        transport: "http",
        auth: { kind: "oauth", secret: "connector-gh" },
      },
      status: "needs_sign_in",
      tools: [],
      createdAt: 1,
      ...more,
    });
    let current = view({});
    const post = vi.fn(async (path: string) => {
      if (path.endsWith("/sign-in")) {
        current = view({ signIn: { expiresAt: 1e15, remote: false } });
        return { opened: true, expiresAt: 1, remote: false } as never;
      }
      return undefined as never;
    });
    const del = vi.fn(async () => {});
    const get = vi.fn(async () => ({ connectors: [current], catalog: [] }));
    const { deps } = setup({ api: { post, del, get } as unknown as ApiClient });
    show({ kind: "app", connector: "gh", name: "GitHub", host: "api.githubcopilot.com" }, deps);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    });
    expect(post).toHaveBeenCalledWith(USE);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(del).not.toHaveBeenCalledWith(USE);
    current = view({});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(del).toHaveBeenCalledWith(USE);
    vi.useRealTimers();
  });

  it("takes back its fix when the key isn't saved", async () => {
    const { deps, del } = setup({}, { save: vi.fn(async () => Promise.reject(new Error("no"))) });
    show({ kind: "key", id: "openai", problem: "rejected" }, deps);
    const region = screen.getByRole("region", { name: "A saved key was refused" });
    fireEvent.change(within(region).getByLabelText(/key/i), { target: { value: OPENAI_SHAPED } });
    fireEvent.submit(within(region).getByRole("form", { name: "Re-enter openai" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith(USE));
  });
});

describe("a fix through the card", () => {
  const USE = `/api/agent/sessions/${SESSION}/blockers/${ID}/use`;
  // The daemon hears before the fix starts, so the fix that follows counts as this card's.
  const heardFirst = (post: ReturnType<typeof setup>["post"], fix: unknown) => {
    expect(post).toHaveBeenCalledWith(USE);
    const said = post.mock.invocationCallOrder[post.mock.calls.findIndex(([p]) => p === USE)];
    expect(said).toBeLessThan(
      (fix as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0] ?? 0,
    );
  };

  it("unlocking", async () => {
    const { deps, post, keys } = setup();
    show({ kind: "keys_locked" }, deps);
    const region = screen.getByRole("region", { name: "Unlock your saved keys" });
    fireEvent.change(within(region).getByLabelText("Passphrase"), {
      target: { value: "correct horse battery" },
    });
    fireEvent.submit(within(region).getByRole("form", { name: "Unlock saved keys" }));
    await waitFor(() => expect(keys.unlock).toHaveBeenCalled());
    heardFirst(post, keys.unlock);
    expect(JSON.stringify(post.mock.calls)).not.toContain("correct horse");
  });

  it("still unlocks when the daemon can't be told", async () => {
    const { deps, post, keys } = setup();
    post.mockRejectedValueOnce(new Error("offline"));
    show({ kind: "keys_locked" }, deps);
    const region = screen.getByRole("region", { name: "Unlock your saved keys" });
    fireEvent.change(within(region).getByLabelText("Passphrase"), {
      target: { value: "correct horse battery" },
    });
    fireEvent.submit(within(region).getByRole("form", { name: "Unlock saved keys" }));
    await waitFor(() => expect(keys.unlock).toHaveBeenCalled());
  });

  it("turning on the computer", async () => {
    const { deps, post } = setup();
    show({ kind: "computer", state: "stopped" }, deps);
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(deps.computer.run).toHaveBeenCalledWith("start"));
    heardFirst(post, deps.computer.run);
  });

  it("starting Docker", async () => {
    const { deps, post } = setup();
    post.mockImplementation(async (path: string) =>
      path === "/api/runtime/start" ? ({ started: true } as never) : (undefined as never),
    );
    show({ kind: "runtime" }, deps);
    fireEvent.click(screen.getByRole("button", { name: "Start Docker" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/runtime/start"));
    expect(post.mock.calls.map(([path]) => path)).toEqual([USE, "/api/runtime/start"]);
  });

  it("opening Keys for a key changed outside localDot", async () => {
    const { deps, post } = setup({}, { keys: [{ ...OPENAI, rebound: true }] });
    show({ kind: "key", id: "openai", problem: "rebound" }, deps);
    fireEvent.click(screen.getByRole("button", { name: "Open Keys" }));
    await waitFor(() => expect(deps.onOpenKeys).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith(USE);
  });
});

describe("a card for each kind", () => {
  it("unlocks saved keys right in the conversation", async () => {
    const { deps, keys } = setup();
    show({ kind: "keys_locked" }, deps);
    const region = screen.getByRole("region", { name: "Unlock your saved keys" });
    expect(region.textContent).toContain("dot carries on by itself");
    expect(region.textContent).toMatch(/Neither localDot nor dot can read it/);
    expect(within(region).queryByRole("button", { name: "Open Keys" })).toBeNull();
    const field = within(region).getByLabelText("Passphrase") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "correct horse battery" } });
    fireEvent.submit(within(region).getByRole("form", { name: "Unlock saved keys" }));
    await waitFor(() => expect(keys.unlock).toHaveBeenCalledWith("correct horse battery"));
    expect(field.value).toBe("");
  });

  it("asks for a first passphrase twice while the vault waits for one", () => {
    const { deps } = setup({}, { health: health("setup") });
    show({ kind: "keys_locked" }, deps);
    const region = screen.getByRole("region", { name: "Choose a passphrase for your saved keys" });
    expect(within(region).getByLabelText("Type it again")).toBeTruthy();
  });

  it("offers no unlock once the keys are open, on the news of any device", () => {
    const blockers = [card({ kind: "keys_locked" })];
    expect(fixesToShow(blockers, health("locked"))).toEqual(blockers);
    expect(fixesToShow(blockers, health("setup"))).toEqual(blockers);
    expect(fixesToShow(blockers, health("ready"))).toEqual([]);
    const other = [card({ kind: "runtime" })];
    expect(fixesToShow(other, health("ready"))).toEqual(other);
  });

  it("offers to try again when the model met the refusal, since the key may be fine", async () => {
    const { deps } = setup();
    show({ kind: "key", id: "openai", problem: "rejected" }, deps, { required: true });
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(deps.retry.run).toHaveBeenCalledOnce());
  });

  it("takes a replacement for a refused key, saved through Keys with nothing else", async () => {
    const { deps, keys, post } = setup();
    show({ kind: "key", id: "openai", problem: "rejected" }, deps);
    const region = screen.getByRole("region", { name: "A saved key was refused" });
    const field = within(region).getByLabelText(/key/i) as HTMLInputElement;
    expect(within(region).queryByLabelText("Name")).toBeNull();
    fireEvent.change(field, { target: { value: OPENAI_SHAPED } });
    fireEvent.submit(within(region).getByRole("form", { name: "Re-enter openai" }));
    await waitFor(() => expect(keys.save).toHaveBeenCalledOnce());
    expect(vi.mocked(keys.save).mock.calls[0]?.[0]).toMatchObject({ id: "openai", kind: "llm" });
    expect(post.mock.calls).toEqual([[`/api/agent/sessions/${SESSION}/blockers/${ID}/use`]]);
  });

  it("re-enters a key that can't be used as stored", () => {
    const { deps } = setup();
    show({ kind: "key", id: "openai", problem: "reenter" }, deps);
    expect(screen.getByRole("region", { name: "Re-enter a saved key" })).toBeTruthy();
  });

  it("sends a key changed outside localDot to Keys, the one case that can't be fixed here", () => {
    const { deps } = setup();
    show({ kind: "key", id: "openai", problem: "rebound" }, deps);
    const region = screen.getByRole("region", { name: /changed outside localDot/ });
    expect(within(region).queryByRole("textbox")).toBeNull();
    fireEvent.click(within(region).getByRole("button", { name: "Open Keys" }));
    expect(deps.onOpenKeys).toHaveBeenCalledOnce();
  });

  it("offers Connect for an app whose sign-in ended, in localDot's words", () => {
    const { deps } = setup();
    (deps.api as unknown as { get: unknown }).get = vi.fn(async () => ({ connectors: [] }));
    show({ kind: "app", connector: "github", name: "GitHub", host: "api.example" }, deps);
    const region = screen.getByRole("region", { name: "Connect GitHub" });
    expect(region.textContent).toContain("api.example");
    expect(within(region).getByRole("button", { name: "Connect" })).toBeTruthy();
  });

  it("tries the model again from the same card, with no way out but the fix", async () => {
    const { deps } = setup();
    show({ kind: "model", reason: STALL.modelRefused, detail: "400: No" }, deps, {
      required: true,
    });
    const region = screen.getByRole("region", { name: /could not process/ });
    expect(region.textContent).toContain("From the provider, not localDot:400: No");
    expect(within(region).queryByRole("button", { name: "Not now" })).toBeNull();
    fireEvent.click(within(region).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(deps.retry.run).toHaveBeenCalledOnce());
  });

  it("never sends the user to Settings about the model", () => {
    const { deps } = setup();
    for (const reason of [
      STALL.modelRefused,
      STALL.modelUnavailable,
      STALL.providerLimit,
      "chatgpt plan limit reached",
      "claude code plan limit reached",
    ] as const) {
      const { unmount } = show({ kind: "model", reason }, { ...deps, stall: { reason } });
      expect(screen.getByRole("region").textContent).not.toMatch(/settings/i);
      unmount();
    }
  });

  it("says when a task paused at its plan's limit continues by itself, and stops on request", async () => {
    const { deps, post } = setup();
    const reason = "claude code plan limit reached";
    const at = new Date(2026, 10, 10, 15, 40).getTime();
    const now = vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 10, 10, 12).getTime());
    const { rerender } = show(
      { kind: "model", reason },
      { ...deps, stall: { reason, autoContinue: { at } } },
      {
        required: true,
      },
    );
    const region = screen.getByRole("region", { name: /^Paused until 3:40/ });
    expect(region.textContent).toContain("dot continues by itself when it resets");
    fireEvent.click(within(region).getByRole("button", { name: "Don't continue" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        `/api/agent/sessions/${deps.sessionId}/auto-continue/cancel`,
      ),
    );
    fireEvent.click(within(region).getByRole("button", { name: "Continue now" }));
    await waitFor(() => expect(deps.retry.run).toHaveBeenCalledOnce());
    now.mockRestore();
    rerender(
      <FixCards
        blockers={[card({ kind: "model", reason }, { required: true })]}
        deps={{ ...deps, stall: { reason, autoContinue: { off: "gave_up" } } }}
      />,
    );
    const gaveUp = screen.getByRole("region", { name: "Paused at your plan's limit" });
    expect(gaveUp.textContent).toContain("stopped waiting");
    expect(within(gaveUp).queryByRole("button", { name: "Don't continue" })).toBeNull();
    expect(within(gaveUp).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("holds the model card while it tries again", () => {
    const { deps } = setup({ stall: undefined });
    show({ kind: "model", reason: STALL.modelRefused }, deps, { required: true });
    expect(screen.getByRole("button", { name: /Trying again/ })).toBeTruthy();
  });

  it("offers Start and Resume for the computer, by what it is", async () => {
    const { deps } = setup();
    const { unmount } = show({ kind: "computer", state: "stopped" }, deps);
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(deps.computer.run).toHaveBeenCalledWith("start"));
    unmount();
    const resuming = setup({
      computer: { action: { kind: "resume", enabled: true }, run: vi.fn() },
    });
    show({ kind: "computer", state: "paused" }, resuming.deps);
    expect(screen.getByRole("region", { name: "Your computer is paused" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(resuming.deps.computer.run).toHaveBeenCalledWith("resume"));
  });

  it("starts Docker, and says what to do when it can't from here", async () => {
    const { deps, post } = setup();
    let started = false;
    post.mockImplementation(async (path: string) =>
      path === "/api/runtime/start" ? ({ started } as never) : (undefined as never),
    );
    show({ kind: "runtime" }, deps);
    fireEvent.click(screen.getByRole("button", { name: "Start Docker" }));
    await screen.findByText(/couldn't start it from here/);
    expect(post).toHaveBeenCalledWith("/api/runtime/start");
    started = true;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText(/Docker is starting/);
    expect(deps.runtimeChanged).toHaveBeenCalled();
  });
});

describe("the model card's other model", () => {
  it("goes on with the chosen model, saved first, with only the model sent", async () => {
    const { deps, post } = setup();
    show({ kind: "model", reason: STALL.providerLimit }, deps, { required: true });
    fireEvent.click(screen.getByRole("combobox", { name: "Model" }));
    fireEvent.click(await screen.findByRole("option", { name: "Kimi K3.1 Pro" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue with Kimi K3.1 Pro" }));
    await waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(deps.models.remember).toHaveBeenCalledWith(KIMI);
    expect(post).toHaveBeenCalledWith(`/api/agent/sessions/${SESSION}/blockers/${ID}/model`, {
      model: {
        provider: "moonshot",
        model: "kimi-k3.1",
        key: "kimi",
        options: { reasoningEffort: "high" },
      },
    });
    expect(deps.retry.run).not.toHaveBeenCalled();
  });

  it("says when it didn't go through, and stays", async () => {
    const { deps, post } = setup({
      models: {
        groups: [{ label: "Models", options: [SONNET, KIMI] }],
        current: KIMI.id,
        differs: true,
        remember: vi.fn(async () => true),
      },
    });
    post.mockRejectedValueOnce(new Error("no"));
    show({ kind: "model", reason: STALL.modelUnavailable }, deps, { required: true });
    fireEvent.click(screen.getByRole("button", { name: "Continue with Kimi K3.1 Pro" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/didn't go through/);
  });
});

describe("Not now", () => {
  it("tells the task through its own route, and asks nothing else", async () => {
    const { deps, post } = setup();
    show({ kind: "computer", state: "stopped" }, deps);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(`/api/agent/sessions/${SESSION}/blockers/${ID}/dismiss`),
    );
  });

  it("is not offered where dot can't go on", () => {
    const { deps } = setup();
    show({ kind: "keys_locked" }, deps, { required: true });
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
  });

  it("says when it didn't go through", async () => {
    const { deps, post } = setup();
    post.mockRejectedValueOnce(new Error("no"));
    show({ kind: "keys_locked" }, deps);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/didn't go through/);
  });
});

describe("what a secret entry card is", () => {
  it("is marked as localDot's own, and keeps several cards apart", () => {
    const { deps } = setup();
    render(
      <FixCards
        blockers={[
          card({ kind: "keys_locked" }),
          card({ kind: "computer", state: "stopped" }, { blockerId: SESSION }),
        ]}
        deps={deps}
      />,
    );
    const regions = screen.getAllByRole("region");
    expect(regions).toHaveLength(2);
    for (const region of regions) expect(region.textContent).toContain("localDot");
  });

  it("can't be drawn by a message: markup in dot's words is only ever words", () => {
    const fake =
      '<section class="thread-fix" data-fix="keys_locked"><h3>Unlock your saved keys</h3><form><input type="password" aria-label="Passphrase"></form></section>';
    const { container } = render(<SafeMarkdown text={fake} />);
    expect(container.querySelector("input, form, section, .thread-fix")).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.queryByLabelText("Passphrase")).toBeNull();
  });

  it("the passphrase leaves the page only sealed", async () => {
    const posted: unknown[] = [];
    const api = {
      get: vi.fn(async () => health("locked")),
      post: vi.fn(async (_path: string, body: unknown) => {
        posted.push(body);
        return { vault: { backend: "file", state: "ready", key: "passphrase" } };
      }),
    } as unknown as ApiClient;
    await unlockKeys(api, "CANARY correct horse battery");
    expect(sealPassphrase).toHaveBeenCalledWith("K", "CANARY correct horse battery");
    expect(JSON.stringify(posted)).toContain("SEALED");
    expect(JSON.stringify(posted)).not.toContain("CANARY");
    expect(sealSecret).not.toHaveBeenCalled();
  });
});

describe("what the message box says while a card is up", () => {
  it("warns where the card takes a secret, and is plain where it doesn't", () => {
    expect(fixWait([])).toBeUndefined();
    expect(fixWait([card({ kind: "keys_locked" })])).toBe("private-fix");
    expect(fixWait([card({ kind: "key", id: "a", problem: "rejected" })])).toBe("private-fix");
    expect(fixWait([card({ kind: "key", id: "a", problem: "reenter" })])).toBe("private-fix");
    expect(fixWait([card({ kind: "key", id: "a", problem: "rebound" })])).toBe("fix");
    expect(fixWait([card({ kind: "runtime" })])).toBe("fix");
    expect(fixWait([card({ kind: "computer", state: "paused" })])).toBeUndefined();
    expect(fixWait([card({ kind: "runtime" }), card({ kind: "keys_locked" })])).toBe("private-fix");
  });
});

describe("the line a card leaves", () => {
  const line = (blocker: AgentBlocker) => {
    render(<FixLine blocker={blocker} />);
    const text = document.querySelector(".thread-divider")?.textContent ?? "";
    cleanup();
    return text;
  };
  const fixed = { blockerId: ID, outcome: "fixed" as const, seq: 2, at: 2, time: 0 };

  it("says what happened, in one line", () => {
    expect(line(card({ kind: "keys_locked" }, { cleared: fixed }))).toContain("Keys unlocked");
    expect(
      line(card({ kind: "key", id: "openai", problem: "rejected" }, { cleared: fixed })),
    ).toContain("openai key saved");
    expect(
      line(card({ kind: "app", connector: "gh", name: "GitHub", host: "h" }, { cleared: fixed })),
    ).toContain("GitHub connected");
    expect(
      line(
        card(
          { kind: "model", reason: STALL.providerLimit },
          { cleared: { ...fixed, movedTo: { provider: "moonshot", model: "kimi-k3.1" } } },
        ),
      ),
    ).toContain("Switched to kimi-k3.1");
    const worked = { ...fixed, outcome: "worked" as const };
    expect(
      line(card({ kind: "key", id: "openai", problem: "rejected" }, { cleared: worked })),
    ).toContain("openai key worked");
    expect(
      line(card({ kind: "app", connector: "gh", name: "GitHub", host: "h" }, { cleared: worked })),
    ).toContain("GitHub worked again");
    expect(line(card({ kind: "computer", state: "stopped" }, { cleared: fixed }))).toContain(
      "Your computer is back on",
    );
    expect(line(card({ kind: "runtime" }, { cleared: fixed }))).toContain("Docker is running");
    expect(
      line(card({ kind: "keys_locked" }, { cleared: { ...fixed, outcome: "dismissed" } })),
    ).toContain("You left your keys locked");
    expect(
      line(card({ kind: "keys_locked" }, { cleared: { ...fixed, outcome: "moved_on" } })),
    ).toContain("Not unlocked: you sent a message instead");
  });

  it("names a model as the user knows it", () => {
    const names = { name: () => "Kimi K3.1 Pro" } as never;
    render(
      <FixLine
        names={names}
        blocker={card(
          { kind: "model", reason: STALL.providerLimit },
          { cleared: { ...fixed, movedTo: { provider: "moonshot", model: "kimi-k3.1" } } },
        )}
      />,
    );
    expect(document.body.textContent).toContain("Switched to Kimi K3.1 Pro");
  });

  it("an old task's card reads as history, never a prompt", () => {
    const old = card({ kind: "keys_locked" }, { seq: 1, at: 1, time: 0 });
    const asHistory = threadItems([], [], [], [], [], undefined, [], [], [old]);
    expect(asHistory.map((item) => item.kind)).toEqual(["fix"]);
    expect(line(old)).toContain("Saved keys were locked");
    const stillWaiting = threadItems([], [], [], [], [], undefined, [], [], [old], true);
    expect(stillWaiting).toEqual([]);
  });

  it("sits where it happened in the thread", () => {
    const cleared = card({ kind: "keys_locked" }, { seq: 1, at: 1, time: 0, cleared: fixed });
    const items = threadItems(
      [
        {
          id: "a",
          role: "assistant",
          text: "Before",
          seq: 1,
          final: true,
        },
        {
          id: "b",
          role: "assistant",
          text: "After",
          seq: 3,
          final: true,
        },
      ] as never,
      [],
      [],
      [],
      [],
      undefined,
      [],
      [],
      [cleared],
    );
    expect(items.map((item) => item.key)).toEqual(["message-a", `fix-${ID}`, "message-b"]);
  });
});
