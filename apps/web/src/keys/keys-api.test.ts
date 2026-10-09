import { describe, expect, it, vi } from "vitest";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { deleteKey, KeyProblem, lockedVaultError, problemText, saveKey } from "./keys-api.ts";
import { protectionOf } from "./Protection.tsx";
import { keyStatus } from "./useKeys.ts";

const binding = {
  id: "weather",
  kind: "http" as const,
  hosts: ["api.weather.example"],
  header: "Authorization",
  format: "bearer" as const,
};
const record = { id: "weather", kind: "http" as const, createdAt: "t", updatedAt: "t" };

function fakeApi(replies: ((path: string, body?: unknown) => unknown)[]) {
  const sent: { method: string; path: string; body?: unknown }[] = [];
  const next = (method: string, path: string, body?: unknown) => {
    sent.push({ method, path, body });
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected ${method} ${path}`);
    return Promise.resolve().then(() => reply(path, body));
  };
  const api: ApiClient = {
    token: "test-token",
    fetch,
    authorization: () => "Bearer test-token",
    get: <T>(path: string) => next("GET", path) as Promise<T>,
    post: <T>(path: string, body?: unknown) => next("POST", path, body) as Promise<T>,
    put: <T>(path: string, body: unknown) => next("PUT", path, body) as Promise<T>,
    del: async (path: string) => {
      await next("DELETE", path);
    },
    socketUrl: (p) => p,
    socketProtocols: () => [],
  };
  return { api, sent };
}

const online = (sealKey: string) => () => ({ online: true, bootId: "b", sealKey });
const fakeSeal = async (key: string, _b: unknown, value: string) => ({
  v: 1 as const,
  epk: key,
  nonce: "n",
  ct: `sealed(${value.length})`,
});

describe("saveKey", () => {
  it("snapshots the strict binding before awaiting health or sealing", async () => {
    const ready = Promise.withResolvers<ReturnType<ReturnType<typeof online>>>();
    const entered = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const current = structuredClone(binding);
    const { api, sent } = fakeApi([() => ready.promise, () => ({ key: record, restart: false })]);
    const snapshots: unknown[] = [];
    const saving = saveKey(api, current, "fake-value-123", async (key, sealedFor, value) => {
      snapshots.push(structuredClone(sealedFor));
      entered.resolve();
      await proceed.promise;
      snapshots.push(structuredClone(sealedFor));
      return fakeSeal(key, sealedFor, value);
    });
    current.id = "changed";
    ready.resolve(online("K1")());
    await entered.promise;
    current.hosts[0] = "another.example";
    proceed.resolve();
    await saving;
    expect(snapshots).toEqual([binding, binding]);
    expect(sent[1]?.body).toMatchObject({ binding });
    expect(sent[1]?.body).not.toHaveProperty("value");
  });

  it("refuses extra binding properties or invalid values before making a request", async () => {
    const { api, sent } = fakeApi([]);
    const seal = vi.fn(fakeSeal);
    const extra = { ...binding, value: "fake-private-value" };
    await expect(saveKey(api, extra, "fake-value-123", seal)).rejects.toThrow();
    for (const value of ["short", "x".repeat(8193), "bad\nvalue", " value123"]) {
      await expect(saveKey(api, binding, value, seal)).rejects.toBeInstanceOf(KeyProblem);
    }
    expect(sent).toEqual([]);
    expect(seal).not.toHaveBeenCalled();
  });

  it("retries only a 409 bad-seal response, at most once", async () => {
    const bad =
      (status: number, error = "bad-seal") =>
      () => {
        throw new ApiError(status, JSON.stringify({ error }));
      };
    for (const [status, error] of [
      [503, "bad-seal"],
      [409, "name-taken"],
    ] as const) {
      const { api, sent } = fakeApi([online("K1"), bad(status, error)]);
      await expect(saveKey(api, binding, "fake-value-123", fakeSeal)).rejects.toMatchObject({
        status,
      });
      expect(sent).toHaveLength(2);
    }
    const { api, sent } = fakeApi([online("K1"), bad(409), online("K2"), bad(409)]);
    await expect(saveKey(api, binding, "fake-value-123", fakeSeal)).rejects.toMatchObject({
      status: 409,
    });
    expect(sent).toHaveLength(4);
  });

  it("seals to keyd's current key and sends only the binding and the ciphertext", async () => {
    const { api, sent } = fakeApi([online("K1"), () => ({ key: record, restart: false })]);
    expect(await saveKey(api, binding, "sk-weather-123", fakeSeal)).toEqual({
      key: record,
      restart: false,
    });
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /api/keyd", "POST /api/keys"]);
    expect(sent[1]?.body).toEqual({
      binding,
      sealed: { v: 1, epk: "K1", nonce: "n", ct: "sealed(14)" },
    });
    expect(JSON.stringify(sent)).not.toContain("sk-weather-123");
  });

  it("seals once more when keyd restarted between reading its key and storing", async () => {
    const badSeal = () => {
      throw new ApiError(409, JSON.stringify({ error: "bad-seal", message: "seal the key again" }));
    };
    const { api, sent } = fakeApi([
      online("K1"),
      badSeal,
      online("K2"),
      () => ({ key: record, restart: true }),
    ]);
    expect(await saveKey(api, binding, "sk-weather-123", fakeSeal)).toMatchObject({
      restart: true,
    });
    const resent = sent[3]?.body as { sealed: { epk: string } } | undefined;
    expect(resent?.sealed.epk).toBe("K2");
  });

  it("refuses to seal while the key layer is offline", async () => {
    const { api } = fakeApi([() => ({ online: false, error: "connect ENOENT" })]);
    await expect(saveKey(api, binding, "sk-weather-123", fakeSeal)).rejects.toBeInstanceOf(
      KeyProblem,
    );
  });
});

describe("problemText", () => {
  it("handles malformed error bodies without throwing or echoing arbitrary exceptions", () => {
    for (const message of [null, 17, true, {}, ["private-value"]]) {
      const error = new ApiError(400, JSON.stringify({ message }));
      expect(() => problemText(error)).not.toThrow();
      expect(problemText(error)).toBe("Something went wrong saving the key. Try again.");
    }
    expect(problemText(new Error("private-value"))).not.toContain("private-value");
    const bounded = problemText(
      new ApiError(400, JSON.stringify({ message: `bad\n${"x".repeat(3000)}` })),
    );
    expect(bounded.length).toBeLessThanOrEqual(513);
    expect(bounded).not.toContain("\n");
  });
  it("turns the daemon's refusals into a sentence", () => {
    expect(
      problemText(
        new ApiError(
          400,
          JSON.stringify({
            error: "bad-binding",
            message: 'keys: header "Cookie" cannot carry a key',
          }),
        ),
      ),
    ).toBe('Header "Cookie" cannot carry a key.');
    expect(problemText(new ApiError(503, "offline"))).toBe(
      "Key protection is off, so the key wasn't saved.",
    );
    expect(problemText(new Error("boom"))).toBe("Something went wrong saving the key. Try again.");
  });

  it("says where to unlock saved keys that are locked", () => {
    const locked = new ApiError(
      423,
      JSON.stringify({ error: "vault-locked", message: "anything the daemon says" }),
    );
    expect(lockedVaultError(locked)).toBe(true);
    expect(problemText(locked)).toBe(
      "Saved keys are locked. On that computer, run: localdot unlock",
    );
    expect(lockedVaultError(new ApiError(423, "{}"))).toBe(false);
  });
});

describe("deleteKey", () => {
  it("names the key in the path", async () => {
    const { api, sent } = fakeApi([() => undefined]);
    await deleteKey(api, "weather");
    expect(sent).toEqual([{ method: "DELETE", path: "/api/keys/weather", body: undefined }]);
  });
});

describe("keyStatus", () => {
  const active = { state: "active" as const, source: "nat-pmp", addresses: 1 };

  it("says the key layer is offline, on hold, or unsure of the public address", () => {
    expect(keyStatus(null)).toEqual({ label: "Keys", state: "unknown" });
    expect(keyStatus({ online: false })).toEqual({ label: "Key protection off", state: "offline" });
    expect(keyStatus({ online: true, audit: { ok: false }, hairpin: active })).toEqual({
      label: "Keys held",
      state: "audit",
    });
    for (const hairpin of [{ state: "unknown" as const, addresses: 0 }, undefined]) {
      expect(keyStatus({ online: true, audit: { ok: true }, hairpin })).toEqual({
        label: "Keys",
        state: "guard",
        spoken: "Keys, network protection checking",
      });
    }
    const off = { state: "off" as const, addresses: 0 };
    expect(keyStatus({ online: true, audit: { ok: true }, hairpin: off }).spoken).toBe(
      "Keys, network protection off",
    );
    expect(keyStatus({ online: true, audit: { ok: true }, hairpin: active })).toEqual({
      label: "Keys",
      state: "ok",
    });
    for (const state of ["locked", "setup"] as const)
      expect(
        keyStatus({ online: true, hairpin: active, vault: { backend: "file", state } }),
      ).toEqual({ label: "Keys locked", state: "locked" });
  });
});

describe("protectionOf", () => {
  const active = { state: "active" as const, source: "nat-pmp", addresses: 1 };
  const row = (health: Parameters<typeof protectionOf>[0]) =>
    protectionOf(health).find((status) => status.name === "Saved keys");

  it("adds saved keys off macOS, with the command that unlocks them", () => {
    expect(row({ online: true, hairpin: active })).toBeUndefined();
    expect(
      row({ online: true, hairpin: active, vault: { backend: "file", state: "locked" } }),
    ).toEqual({
      name: "Saved keys",
      state: "Locked",
      tone: "bad",
      problem: "Saved keys are locked.",
      fix: { lead: "On that computer, run:", command: "localdot unlock" },
    });
    expect(
      row({ online: true, hairpin: active, vault: { backend: "file", state: "setup" } })?.state,
    ).toBe("Needs a passphrase");
    expect(
      row({ online: true, hairpin: active, vault: { backend: "secret-service", state: "ready" } }),
    ).toEqual({ name: "Saved keys", state: "In your keyring", tone: "ok" });
  });
});
