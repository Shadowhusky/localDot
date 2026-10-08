import { bindingJson, LLM_PROVIDERS, SecretBinding } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import {
  bindingOf,
  describeKey,
  EMPTY_DRAFT,
  type KeyDraft,
  needsBaseURL,
  PROVIDER_GROUPS,
  PROVIDER_NAMES,
  suggestedId,
  valueHint,
  valueProblem,
} from "./binding.ts";

const draft = (over: Partial<KeyDraft>): KeyDraft => ({ ...EMPTY_DRAFT, ...over });

describe("bindingOf", () => {
  it("names every supported provider and builds its binding", () => {
    for (const provider of LLM_PROVIDERS) {
      expect(PROVIDER_NAMES[provider]).toBeTypeOf("string");
      const result = bindingOf(
        draft({ id: "test", provider, baseURL: "https://api.example.com/v1" }),
      );
      expect(result).toEqual({
        ok: true,
        binding: {
          id: "test",
          kind: "llm",
          provider,
          ...(needsBaseURL(provider) ? { baseURL: "https://api.example.com/v1" } : {}),
        },
      });
    }
  });
  it("builds a preset provider's binding with no base URL", () => {
    expect(
      bindingOf(draft({ id: " anthropic ", provider: "anthropic", baseURL: "https://x.test" })),
    ).toEqual({
      ok: true,
      binding: { id: "anthropic", kind: "llm", provider: "anthropic" },
    });
  });

  it("sends a base URL as the URL parser writes it, so the sealed binding is printable ASCII", () => {
    const check = bindingOf(
      draft({
        id: "groq",
        provider: "openai-compatible",
        baseURL: " https://API.groq.com/openai/v1 ",
      }),
    );
    expect(check).toEqual({
      ok: true,
      binding: {
        id: "groq",
        kind: "llm",
        provider: "openai-compatible",
        baseURL: "https://api.groq.com/openai/v1",
      },
    });
    const unicode = bindingOf(
      draft({ id: "b", provider: "azure", baseURL: "https://bücher.example/v1/ x" }),
    );
    expect(unicode.ok && unicode.binding.kind === "llm" ? unicode.binding.baseURL : "").toBe(
      "https://xn--bcher-kva.example/v1/%E2%80%A8x",
    );
    if (unicode.ok) expect(() => bindingJson(unicode.binding)).not.toThrow();
  });

  it("refuses base URLs keyd would refuse", () => {
    for (const baseURL of [
      "",
      "http://api.example.com/v1",
      "https://u:p@api.example.com",
      "https://api.example.com:8443/v1",
      "https://api.example.com/v1?x=1",
      "https://api.example.com/#a",
      "not a url",
    ]) {
      expect(bindingOf(draft({ id: "x", provider: "openai-compatible", baseURL }))).toMatchObject({
        ok: false,
        field: "baseURL",
      });
    }
  });

  it("asks Anthropic-compatible keys for a base URL, ending it in /v1 where Anthropic's API lives", () => {
    expect(needsBaseURL("anthropic-compatible")).toBe(true);
    for (const [typed, sealed] of [
      ["https://api.z.ai/api/anthropic", "https://api.z.ai/api/anthropic/v1"],
      ["https://api.z.ai/api/anthropic/", "https://api.z.ai/api/anthropic/v1"],
      [" https://API.minimax.io/anthropic/v1 ", "https://api.minimax.io/anthropic/v1"],
      ["https://api.minimax.io/anthropic/v1/", "https://api.minimax.io/anthropic/v1"],
      ["https://llm.example.com", "https://llm.example.com/v1"],
    ])
      expect(
        bindingOf(draft({ id: "anc", provider: "anthropic-compatible", baseURL: typed })),
        typed,
      ).toEqual({
        ok: true,
        binding: { id: "anc", kind: "llm", provider: "anthropic-compatible", baseURL: sealed },
      });
    // An OpenAI-compatible address is the one the vendor gives, version path and all.
    expect(
      bindingOf(
        draft({ id: "z", provider: "openai-compatible", baseURL: "https://api.z.ai/api/paas/v4" }),
      ),
    ).toMatchObject({ ok: true, binding: { baseURL: "https://api.z.ai/api/paas/v4" } });
  });

  it("sends Anthropic's own API to the Anthropic provider", () => {
    for (const baseURL of ["https://api.anthropic.com", "https://api.anthropic.com/v1"])
      expect(bindingOf(draft({ id: "anc", provider: "anthropic-compatible", baseURL }))).toEqual({
        ok: false,
        field: "baseURL",
        message: "For Anthropic's own API, choose Anthropic as the provider.",
      });
  });

  it("refuses addresses and names that are not a public host, as keyd does", () => {
    for (const provider of ["openai-compatible", "anthropic-compatible"] as const)
      for (const baseURL of [
        "https://127.0.0.1/v1",
        "https://192.168.1.20:443/v1",
        "https://[::1]/v1",
        "https://localhost/v1",
        "https://10.0.0.8/anthropic",
      ])
        expect(bindingOf(draft({ id: "x", provider, baseURL })), baseURL).toMatchObject({
          ok: false,
          field: "baseURL",
        });
  });

  it("splits, lower-cases and de-duplicates hosts, and keeps the header as typed", () => {
    expect(
      bindingOf(
        draft({
          kind: "http",
          id: "weather",
          hosts: "API.weather.example, api.weather.example\nmaps.example",
          header: "X-Api-Key",
          format: "raw",
        }),
      ),
    ).toEqual({
      ok: true,
      binding: {
        id: "weather",
        kind: "http",
        hosts: ["api.weather.example", "maps.example"],
        header: "X-Api-Key",
        format: "raw",
      },
    });
  });

  it("names the field to fix", () => {
    expect(bindingOf(draft({ id: "Weather" }))).toMatchObject({ ok: false, field: "id" });
    expect(bindingOf(draft({ id: "lmstudio" }))).toMatchObject({ ok: false, field: "id" });
    expect(bindingOf(draft({ kind: "http", id: "w", hosts: "" }))).toMatchObject({
      ok: false,
      field: "hosts",
    });
    expect(
      bindingOf(draft({ kind: "http", id: "w", hosts: "https://api.example.com/v1" })),
    ).toMatchObject({ ok: false, field: "hosts" });
    expect(bindingOf(draft({ kind: "http", id: "w", hosts: "10.0.0.1" }))).toMatchObject({
      ok: false,
      field: "hosts",
    });
    expect(
      bindingOf(draft({ kind: "http", id: "w", hosts: "a.example", header: "X Key" })),
    ).toMatchObject({ ok: false, field: "header" });
    expect(
      bindingOf(
        draft({ kind: "http", id: "w", hosts: "a.example", header: "X-Key", format: "basic-user" }),
      ),
    ).toMatchObject({ ok: false, field: "header" });
  });

  it("only ever produces bindings the daemon accepts", () => {
    const samples = [
      draft({ id: "a" }),
      draft({ id: "g", provider: "google" }),
      draft({ kind: "http", id: "w", hosts: "a.example", format: "basic-password" }),
    ];
    for (const d of samples) {
      const check = bindingOf(d);
      expect(check.ok && SecretBinding.safeParse(check.binding).success).toBe(true);
    }
  });
});

describe("valueProblem", () => {
  it("accepts 8 to 8192 printable ASCII characters", () => {
    expect(valueProblem("sk-ant-0123")).toBeUndefined();
    expect(valueProblem("x".repeat(8192))).toBeUndefined();
    for (const bad of [
      "short",
      "x".repeat(8193),
      "sk-ant-é123456",
      "sk-ant\t0123456",
      " value123",
      "value123 ",
    ]) {
      expect(valueProblem(bad)).toBeDefined();
    }
  });
});

describe("Claude plan tokens", () => {
  const SENTENCE =
    "Claude Pro and Max plans can't be used here: Anthropic doesn't allow other apps to sign in with them. Add an Anthropic API key instead.";
  it("refuses a pasted plan token with the sentence, whatever the key is for", () => {
    for (const value of [`sk-ant-oat01-${"a".repeat(95)}`, `sk-ant-oat02-${"b".repeat(40)}`])
      expect(valueProblem(value)).toBe(SENTENCE);
    expect(valueProblem(`sk-ant-api03-${"a".repeat(95)}`)).toBeUndefined();
    expect(valueProblem(`sk-ant-admin01-${"a".repeat(95)}`)).toBeUndefined();
  });
  it("refuses a plan token with anything around it, and Claude's refresh and session tokens", () => {
    const token = `sk-ant-oat01-${"a".repeat(95)}`;
    for (const value of [
      `export CLAUDE_CODE_OAUTH_TOKEN=${token}`,
      `"${token}"`,
      `Bearer ${token}`,
      `abc${token}`,
      `sk-ant-ort01-${"b".repeat(95)}`,
      `sk-ant-sid01-${"c".repeat(95)}`,
    ])
      expect(valueProblem(value), value).toBe(SENTENCE);
  });
  it("says what an Anthropic key starts with, and nothing for other keys", () => {
    expect(valueHint(draft({ provider: "anthropic" }))).toBe("sk-ant-api");
    expect(valueHint(draft({ provider: "openai" }))).toBeUndefined();
    expect(valueHint(draft({ kind: "http", provider: "anthropic" }))).toBeUndefined();
  });
});

describe("describeKey", () => {
  it("does not crash the key list on old or invalid URL metadata", () => {
    expect(describeKey({ kind: "llm", provider: "azure", baseURL: "not a URL" })).toBe(
      "Azure OpenAI",
    );
  });
  it("reads as the provider, or the hosts and header", () => {
    expect(describeKey({ kind: "llm", provider: "anthropic" })).toBe("Anthropic");
    expect(
      describeKey({
        kind: "llm",
        provider: "openai-compatible",
        baseURL: "https://api.groq.com/openai/v1",
      }),
    ).toBe("OpenAI-compatible · api.groq.com");
    expect(
      describeKey({
        kind: "llm",
        provider: "anthropic-compatible",
        baseURL: "https://api.z.ai/api/anthropic/v1",
      }),
    ).toBe("Anthropic-compatible · api.z.ai");
    expect(
      describeKey({ kind: "http", hosts: ["a.example", "b.example"], header: "Authorization" }),
    ).toBe("a.example, b.example · Authorization");
  });
});

describe("PROVIDER_GROUPS", () => {
  it("offers every provider once", () => {
    const offered = PROVIDER_GROUPS.flatMap((group) => group.providers);
    expect([...offered].sort()).toEqual([...LLM_PROVIDERS].sort());
  });
});

describe("suggestedId", () => {
  it("names a key after its provider, then -2, -3 past names already saved", () => {
    expect(suggestedId(draft({ provider: "anthropic" }), [])).toBe("anthropic");
    expect(suggestedId(draft({ provider: "anthropic" }), ["anthropic", "anthropic-2"])).toBe(
      "anthropic-3",
    );
    expect(suggestedId(draft({ provider: "openai-compatible" }), [])).toBe("openai-compatible");
  });
  it("names a web API key after the service in its first host, even one typed as a URL", () => {
    const named = (hosts: string) => suggestedId(draft({ kind: "http", hosts }), []);
    expect(named("api.weather.example, b.example")).toBe("weather");
    expect(named("https://api.weather.example:8443/v1")).toBe("weather");
    expect(named("www.openweathermap.org")).toBe("openweathermap");
    expect(named("localhost")).toBe("web-api");
    expect(named("")).toBe("web-api");
    expect(suggestedId(draft({ kind: "http", hosts: "x.example" }), ["x", "x-2"])).toBe("x-3");
  });
  it("never suggests a name kept for local servers", () => {
    expect(suggestedId(draft({ kind: "http", hosts: "ollama.example" }), [])).toBe("ollama-2");
  });
});
