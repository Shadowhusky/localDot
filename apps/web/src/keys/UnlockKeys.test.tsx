// @vitest-environment jsdom
import { sealPassphrase } from "@localdot/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeysLockedCard } from "../agent/KeysLockedCard.tsx";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { KeysPanel } from "./KeysPanel.tsx";
import { type KeydHealth, unlockKeys, unlockProblem } from "./keys-api.ts";
import type { KeysController } from "./useKeys.ts";

afterEach(cleanup);

const PASSPHRASE = "correct horse battery";
const health = (state: "locked" | "setup"): KeydHealth => ({
  online: true,
  bootId: "b",
  sealKey: "K",
  audit: { ok: true },
  hairpin: { state: "active", source: "nat-pmp", addresses: 1 },
  vault: { backend: "file", state, ...(state === "locked" ? { key: "passphrase" } : {}) },
});
function controller(state: "locked" | "setup", unlock: KeysController["unlock"]): KeysController {
  return {
    health: health(state),
    keys: [],
    loadError: null,
    busy: false,
    save: vi.fn(async () => ({ restart: false })),
    remove: vi.fn(async () => {}),
    unlock,
  };
}
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const refusal = (status: number, body: object) => new ApiError(status, JSON.stringify(body));

describe("unlocking saved keys in Keys", () => {
  it("says what the lock is, takes the passphrase once and clears it", async () => {
    const unlock = vi.fn(async () => {});
    render(<KeysPanel active keys={controller("locked", unlock)} />);
    const form = screen.getByRole("form", { name: "Unlock saved keys" });
    expect(screen.getByText(/lock each time the computer running localDot restarts/)).toBeTruthy();
    expect(screen.getByText(/Neither localDot nor dot can read it/)).toBeTruthy();
    expect(document.getElementById("keys-unlock")?.contains(form)).toBe(true);
    expect(field("Passphrase").type).toBe("password");
    fireEvent.change(field("Passphrase"), { target: { value: PASSPHRASE } });
    fireEvent.submit(form);
    await waitFor(() => expect(unlock).toHaveBeenCalledWith(PASSPHRASE));
    expect(field("Passphrase").value).toBe("");
  });

  it("asks a new vault for its passphrase twice, and never sends one too short or unmatched", async () => {
    const unlock = vi.fn(async () => {});
    render(<KeysPanel active keys={controller("setup", unlock)} />);
    const form = screen.getByRole("form", { name: "Choose a passphrase" });
    expect(screen.getByText(/has no keyring/)).toBeTruthy();
    fireEvent.change(field("New passphrase"), { target: { value: "short" } });
    fireEvent.change(field("Type it again"), { target: { value: "short" } });
    fireEvent.submit(form);
    expect(await screen.findByText("Use at least 12 characters.")).toBeTruthy();
    fireEvent.change(field("New passphrase"), { target: { value: PASSPHRASE } });
    fireEvent.change(field("Type it again"), { target: { value: `${PASSPHRASE}.` } });
    fireEvent.submit(form);
    expect(await screen.findByText("The passphrases don't match.")).toBeTruthy();
    expect(unlock).not.toHaveBeenCalled();
    fireEvent.change(field("New passphrase"), { target: { value: PASSPHRASE } });
    fireEvent.change(field("Type it again"), { target: { value: PASSPHRASE } });
    fireEvent.click(screen.getByRole("button", { name: "Save passphrase" }));
    await waitFor(() => expect(unlock).toHaveBeenCalledWith(PASSPHRASE));
  });

  it("says plainly when the passphrase is wrong, and empties the field for another try", async () => {
    const unlock = vi.fn(async () => {
      throw refusal(403, { error: "wrong-passphrase", message: "anything" });
    });
    render(<KeysPanel active keys={controller("locked", unlock)} />);
    fireEvent.change(field("Passphrase"), { target: { value: PASSPHRASE } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByText("That passphrase doesn't unlock your saved keys.")).toBeTruthy();
    expect(field("Passphrase").value).toBe("");
    expect(document.activeElement).toBe(field("Passphrase"));
  });

  it("shows no form while the keys are open", () => {
    render(
      <KeysPanel
        active
        keys={{
          ...controller("locked", vi.fn()),
          health: { ...health("locked"), vault: { backend: "file", state: "ready" } },
        }}
      />,
    );
    expect(screen.queryByRole("form", { name: "Unlock saved keys" })).toBeNull();
  });
});

describe("the chat's Unlock card", () => {
  it("unlocks in place, with Keys a button away", async () => {
    const unlock = vi.fn(async () => {});
    const onOpenKeys = vi.fn();
    render(<KeysLockedCard setup={false} unlock={unlock} onOpenKeys={onOpenKeys} />);
    expect(screen.getByRole("heading", { name: "Unlock your saved keys" })).toBeTruthy();
    expect(screen.getByText(/dot carries on by itself/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Keys" }));
    expect(onOpenKeys).toHaveBeenCalledWith(screen.getByRole("button", { name: "Open Keys" }));
    fireEvent.change(field("Passphrase"), { target: { value: PASSPHRASE } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(unlock).toHaveBeenCalledWith(PASSPHRASE));
  });
});

describe("unlockKeys", () => {
  function fakeApi(replies: ((path: string, body: unknown) => unknown)[]) {
    const sent: { method: string; path: string; body: unknown }[] = [];
    const answer = async (method: string, path: string, body?: unknown) => {
      sent.push({ method, path, body });
      const reply = replies.shift();
      if (!reply) throw new Error(`unexpected ${method} ${path}`);
      return reply(path, body);
    };
    const api = {
      get: (path: string) => answer("GET", path),
      post: (path: string, body: unknown) => answer("POST", path, body),
    } as unknown as ApiClient;
    return { api, sent };
  }
  const SEAL_KEY =
    "BG2x8-BG3l6OwZSDEY2jv15f49mKcudyq5wvNeAMGomjt95F3U2ihX3pW1kqXeAogtDMs6rhGvlhvnCeU3XFwgM";

  it("sends only the passphrase sealed to keyd's key, and seals again for a restarted keyd", async () => {
    const seal = vi.fn(sealPassphrase);
    const { api, sent } = fakeApi([
      () => ({ online: true, sealKey: SEAL_KEY }),
      () => {
        throw refusal(409, { error: "bad-seal", message: "seal the key again" });
      },
      () => ({ online: true, sealKey: SEAL_KEY }),
      () => ({ vault: { backend: "file", state: "ready" } }),
    ]);
    expect(await unlockKeys(api, PASSPHRASE, seal)).toEqual({ backend: "file", state: "ready" });
    expect(seal).toHaveBeenCalledTimes(2);
    const posts = sent.filter((call) => call.method === "POST");
    expect(posts.map((call) => call.path)).toEqual(["/api/keyd/unlock", "/api/keyd/unlock"]);
    for (const { body } of posts) {
      expect(Object.keys(body as object)).toEqual(["sealed"]);
      expect(JSON.stringify(body)).not.toContain(PASSPHRASE);
    }
  });

  it("refuses to send anything while key protection is off", async () => {
    const { api, sent } = fakeApi([() => ({ online: false })]);
    await expect(unlockKeys(api, PASSPHRASE)).rejects.toThrow(/can't be unlocked/);
    expect(sent.some((call) => call.method === "POST")).toBe(false);
  });

  it("puts each refusal in a sentence", () => {
    expect(unlockProblem(refusal(429, { error: "too-many-tries", retryAfter: 30 }))).toBe(
      "Too many wrong passphrases. Try again in a minute.",
    );
    expect(unlockProblem(refusal(429, { error: "too-many-tries", retryAfter: 240 }))).toBe(
      "Too many wrong passphrases. Try again in 4 minutes.",
    );
    expect(unlockProblem(refusal(403, { error: "owner-only" }))).toBe(
      "Only the owner of this localDot can unlock its keys.",
    );
    expect(unlockProblem(new ApiError(503, "offline"))).toMatch(/can't be unlocked right now/);
    expect(unlockProblem(new Error("boom"))).toBe("Your keys couldn't be unlocked. Try again.");
  });
});
