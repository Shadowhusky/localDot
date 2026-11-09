// @vitest-environment jsdom
import { type Blocker, STALL, sealPassphrase, sealSecret } from "@localdot/protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  const api = { post } as unknown as ApiClient;
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
  return { deps, post, keys };
}
const card = (blocker: Blocker, extra: Partial<AgentBlocker> = {}): AgentBlocker => ({
  blockerId: ID,
  blocker,
  by: "localdot",
  ...extra,
});
const show = (blocker: Blocker, deps: FixDeps, extra: Partial<AgentBlocker> = {}) =>
  render(<FixCards blockers={[card(blocker, extra)]} deps={deps} />);

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
    const region = screen.getByRole("region", { name: "Your openai key was refused" });
    const field = within(region).getByLabelText(/key/i) as HTMLInputElement;
    expect(within(region).queryByLabelText("Name")).toBeNull();
    fireEvent.change(field, { target: { value: "sk-replacement" } });
    fireEvent.submit(within(region).getByRole("form", { name: "Re-enter openai" }));
    await waitFor(() => expect(keys.save).toHaveBeenCalledOnce());
    expect(vi.mocked(keys.save).mock.calls[0]?.[0]).toMatchObject({ id: "openai", kind: "llm" });
    expect(post).not.toHaveBeenCalled();
  });

  it("re-enters a key that can't be used as stored", () => {
    const { deps } = setup();
    show({ kind: "key", id: "openai", problem: "reenter" }, deps);
    expect(screen.getByRole("region", { name: "Re-enter your openai key" })).toBeTruthy();
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
    expect(region.textContent).toContain("The provider said: 400: No");
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

  it("holds the model card while it tries again", () => {
    const { deps } = setup({ stall: undefined });
    show({ kind: "model", reason: STALL.modelRefused }, deps, { required: true });
    expect(screen.getByRole("button", { name: /Trying again/ })).toBeTruthy();
  });

  it("offers Start and Resume for the computer, by what it is", () => {
    const { deps } = setup();
    const { unmount } = show({ kind: "computer", state: "stopped" }, deps);
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(deps.computer.run).toHaveBeenCalledWith("start");
    unmount();
    const resuming = setup({
      computer: { action: { kind: "resume", enabled: true }, run: vi.fn() },
    });
    show({ kind: "computer", state: "paused" }, resuming.deps);
    expect(screen.getByRole("region", { name: "Your computer is paused" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(resuming.deps.computer.run).toHaveBeenCalledWith("resume");
  });

  it("starts Docker, and says what to do when it can't from here", async () => {
    const { deps, post } = setup();
    post.mockResolvedValueOnce({ started: false } as never);
    show({ kind: "runtime" }, deps);
    fireEvent.click(screen.getByRole("button", { name: "Start Docker" }));
    await screen.findByText(/couldn't start it from here/);
    expect(post).toHaveBeenCalledWith("/api/runtime/start");
    post.mockResolvedValueOnce({ started: true } as never);
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
