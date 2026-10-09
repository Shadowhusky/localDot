import { describe, expect, it } from "vitest";
import {
  KeydEvent,
  KeydOpened,
  KeydStatus,
  RESERVED_SECRET_IDS,
  Sealed,
  SealedSecret,
  SecretBinding,
  SecretId,
  SURROGATE_PATTERN,
  surrogateEnvClash,
  surrogateEnvName,
} from "./keyd.ts";

const sealed = {
  v: 1,
  epk: "BLhfkHvMwLU1VR2xt2QbapafF0HZL1U_EABDIa8GocmgFNZqvKrR0ZinBw_bbXXvp1tZIDoT8KptqEj3qt86wj0",
  nonce: "AAECAwQFBgcICQoL",
  ct: "wpSd7tLllnTJVPphF6Utcgorgp-jGSSn9dEwVhuXCcB6rJ_hpNaF",
};

describe("SecretBinding", () => {
  it("accepts every provider supported by the amended keyd gateway", () => {
    for (const provider of [
      "anthropic",
      "openai",
      "google",
      "xai",
      "mistral",
      "deepseek",
      "groq",
      "openrouter",
      "openai-compatible",
      "azure",
    ]) {
      expect(
        SecretBinding.safeParse({ id: "provider-key", kind: "llm", provider }).success,
        provider,
      ).toBe(true);
    }
  });

  it("refuses plaintext inside either binding or the sealed blob", () => {
    const bindings = [
      { id: "api", kind: "llm", provider: "openai" },
      {
        id: "web",
        kind: "http",
        hosts: ["api.example.test"],
        header: "Authorization",
        format: "bearer",
      },
    ];
    for (const binding of bindings) {
      expect(
        SealedSecret.safeParse({ binding: { ...binding, value: "canary-plaintext" }, sealed })
          .success,
      ).toBe(false);
      expect(
        SealedSecret.safeParse({ binding, sealed: { ...sealed, value: "canary-plaintext" } })
          .success,
      ).toBe(false);
    }
  });

  it("accepts the two kinds keyd stores", () => {
    expect(SecretBinding.parse({ id: "anthropic", kind: "llm", provider: "anthropic" }).kind).toBe(
      "llm",
    );
    expect(
      SecretBinding.parse({
        id: "weather-api",
        kind: "http",
        hosts: ["api.weather.example"],
        header: "X-Api-Key",
        format: "raw",
      }).kind,
    ).toBe("http");
  });

  it("refuses unknown fields, a value field above all, so plaintext can't ride along", () => {
    expect(() =>
      SecretBinding.parse({
        id: "a1",
        kind: "llm",
        provider: "openai",
        value: "real-secret-value",
      }),
    ).toThrow();
    expect(() =>
      SealedSecret.parse({
        binding: { id: "a1", kind: "llm", provider: "openai" },
        sealed,
        value: "x",
      }),
    ).toThrow();
  });

  it("refuses bad ids, reserved ids, empty host lists and non-ASCII text", () => {
    for (const id of ["", "Upper", "-lead", "a/b", "lmstudio", "ollama", "x".repeat(65)]) {
      expect(() => SecretBinding.parse({ id, kind: "llm", provider: "openai" }), id).toThrow();
    }
    expect(() =>
      SecretBinding.parse({ id: "w", kind: "http", hosts: [], header: "X", format: "raw" }),
    ).toThrow();
    expect(() =>
      SecretBinding.parse({
        id: "w",
        kind: "http",
        hosts: ["bücher.example"],
        header: "X",
        format: "raw",
      }),
    ).toThrow();
    expect(() =>
      SecretBinding.parse({
        id: "g",
        kind: "llm",
        provider: "openai-compatible",
        baseURL: "https://e.example/ ",
      }),
    ).toThrow();
  });
});

describe("Sealed", () => {
  it("accepts a v1 blob and refuses padding, other versions and short nonces", () => {
    expect(Sealed.parse(sealed)).toEqual(sealed);
    expect(() => Sealed.parse({ ...sealed, v: 2 })).toThrow();
    expect(() => Sealed.parse({ ...sealed, ct: `${sealed.ct}==` })).toThrow();
    expect(() => Sealed.parse({ ...sealed, nonce: "AAEC" })).toThrow();
  });
});

describe("keyd replies", () => {
  it("parses an opened cell and refuses a surrogate that is not one", () => {
    const opened = {
      cellId: "01JXYZ0000000000000000ABCD",
      port: 4760,
      proxyToken: "j6CLzsRw79yMKkRwPznckks1fdcXOOnPN3DYp3Al_gk",
      caCertPem: "-----BEGIN CERTIFICATE-----\nMII\n-----END CERTIFICATE-----\n",
      caPath: "/tmp/ld/keyd/cells/c/ca.pem",
      surrogates: { weather: "ld_key_0123456789abcdefABCDEF_abc123" },
    };
    expect(KeydOpened.parse(opened).surrogates?.weather).toMatch(SURROGATE_PATTERN);
    expect(() =>
      KeydOpened.parse({ ...opened, surrogates: { weather: "ld_key_x'; rm -rf /'" } }),
    ).toThrow();
  });

  it("parses the three event types and refuses others", () => {
    const keyUse = {
      type: "key.use",
      cell: "c1",
      time: "2026-10-01T12:00:00.123Z",
      data: {
        secretId: "weather",
        host: "api.weather.example",
        method: "GET",
        path: "/v1",
        decision: "allow",
      },
    };
    expect(KeydEvent.parse(keyUse).type).toBe("key.use");
    expect(
      KeydEvent.parse({
        type: "budget.exceeded",
        cell: "c1",
        time: "t",
        data: { scope: "task", taskId: "t1", limitUSD: 5, spentUSD: 5.1 },
      }).type,
    ).toBe("budget.exceeded");
    expect(KeydEvent.parse({ type: "events.dropped", time: "t", data: { count: 4 } }).type).toBe(
      "events.dropped",
    );
    expect(() => KeydEvent.parse({ ...keyUse, type: "key.leak" })).toThrow();
    const ask = {
      type: "egress.ask",
      cell: "c1",
      time: "t",
      data: {
        id: "0".repeat(32),
        host: "chat.example.com",
        port: 5222,
        source: 40000,
        via: "capture",
      },
    };
    expect(KeydEvent.parse(ask).type).toBe("egress.ask");
    expect(() => KeydEvent.parse({ ...ask, data: { ...ask.data, port: 0 } })).toThrow();
    expect(() => KeydEvent.parse({ ...ask, data: { ...ask.data, via: "tunnel" } })).toThrow();
    expect(() =>
      KeydEvent.parse({ ...keyUse, data: { ...keyUse.data, decision: "maybe" } }),
    ).toThrow();
  });
});

describe("surrogateEnvName", () => {
  it("prefixes every name so no key can shadow PATH or a proxy variable", () => {
    expect(surrogateEnvName("weather")).toBe("LOCALDOT_KEY_WEATHER");
    expect(surrogateEnvName("open-weather_2")).toBe("LOCALDOT_KEY_OPEN_WEATHER_2");
    expect(surrogateEnvName("path")).toBe("LOCALDOT_KEY_PATH");
    expect(surrogateEnvName("https_proxy")).toBe("LOCALDOT_KEY_HTTPS_PROXY");
  });

  it("names the stored key whose variable a new name would share", () => {
    expect(surrogateEnvClash("open-weather", ["maps", "open_weather"])).toBe("open_weather");
    expect(surrogateEnvClash("open_weather", ["open_weather", "maps"])).toBeUndefined();
    expect(surrogateEnvClash("weather", ["weather-2", "weather_api"])).toBeUndefined();
  });
});

describe("KeydStatus", () => {
  const status = {
    bootId: "0123456789abcdef",
    version: "0.1.0",
    sealKey: sealed.epk,
    cells: 0,
    secrets: 0,
    limits: { perTaskUSD: 5, perDayUSD: 20 },
    day: { date: "2026-10-01", spentUSD: 0 },
    audit: { ok: true },
  };

  it("reads the hairpin guard's state, and a state it does not know as unknown", () => {
    const active = { state: "active", source: "nat-pmp", addresses: 1, checkedAt: "t" };
    expect(KeydStatus.parse({ ...status, hairpin: active }).hairpin).toEqual(active);
    expect(
      KeydStatus.parse({ ...status, hairpin: { state: "learning", addresses: 0 } }).hairpin?.state,
    ).toBe("unknown");
    expect(KeydStatus.parse(status).hairpin).toBeUndefined();
    expect(KeydStatus.parse({ ...status, hairpin: null }).hairpin).toBeNull();
  });
});

describe("push key name", () => {
  it("reserves keyd's push key name", () => {
    expect(RESERVED_SECRET_IDS).toContain("webpush-vapid");
    expect(SecretId.safeParse("webpush-vapid").success).toBe(false);
  });
});
