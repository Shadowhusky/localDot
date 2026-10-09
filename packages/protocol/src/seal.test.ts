import { describe, expect, it } from "vitest";
import type { Sealed, SecretBinding } from "./keyd.ts";
import {
  BindingTextError,
  bindingJson,
  type EcPrivateJwk,
  fromBase64url,
  SEAL_INFO,
  sealPassphrase,
  sealSecret,
} from "./seal.ts";

// keyd's fixed test key from Part 4a's vault/seal_test.go (scalar 6b1f3c2a…17f8).
const KEYD_PUBLIC =
  "BG2x8-BG3l6OwZSDEY2jv15f49mKcudyq5wvNeAMGomjt95F3U2ihX3pW1kqXeAogtDMs6rhGvlhvnCeU3XFwgM";
const KEYD_PRIVATE: EcPrivateJwk = {
  kty: "EC",
  crv: "P-256",
  x: "bbHz4EbeXo7BlIMRjaO_Xl_j2Ypy53KrnC814AwaiaM",
  y: "t95F3U2ihX3pW1kqXeAogtDMs6rhGvlhvnCeU3XFwgM",
  d: "ax88Kp2Of2BRQjMkFQb36NnKu6ydjn9gUUIzJBUGF_g",
};
// A pinned ephemeral key (scalar 1f2e3d4c…8b9a) and nonce for known-answer vectors.
const EPHEMERAL: EcPrivateJwk = {
  kty: "EC",
  crv: "P-256",
  x: "uF-Qe8zAtTVVHbG3ZBtqlp8XQdkvVT8QAEMhrwahyaA",
  y: "FNZqvKrR0ZinBw_bbXXvp1tZIDoT8KptqEj3qt86wj0",
  d: "Hy49TFtqeYgXJjVEU2JxgKm4x9bl9AMSITBPXm18i5o",
};
const NONCE = Uint8Array.from({ length: 12 }, (_, i) => i);
const VALUE = "fake-key-from-webcrypto";

const weather: SecretBinding = {
  id: "weather",
  kind: "http",
  hosts: ["api.example.test", "b.example.test"],
  header: "Authorization",
  format: "bearer",
  methods: ["GET"],
  paths: ["/v1/a&b/"],
};
const groq: SecretBinding = {
  id: "groq",
  kind: "llm",
  provider: "openai-compatible",
  baseURL: "https://api.groq.com/openai/v1",
};

// What keyd does with a sealed value, in WebCrypto: the test's stand-in for vault.Opener.
async function open(sealed: Sealed, binding: SecretBinding): Promise<string> {
  const { subtle } = globalThis.crypto;
  const keyd = await subtle.importKey(
    "jwk",
    KEYD_PRIVATE,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const epkRaw = fromBase64url(sealed.epk);
  const epk = await subtle.importKey(
    "raw",
    epkRaw,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = await subtle.deriveBits({ name: "ECDH", public: epk }, keyd, 256);
  const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const salt = new Uint8Array([...epkRaw, ...fromBase64url(KEYD_PUBLIC)]);
  const key = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode(SEAL_INFO) },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const plain = await subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64url(sealed.nonce),
      additionalData: new TextEncoder().encode(`${SEAL_INFO}:${bindingJson(binding)}`),
    },
    key,
    fromBase64url(sealed.ct),
  );
  return new TextDecoder().decode(plain);
}

describe("sealSecret", () => {
  it("produces the vectors keyd's Go opener opens", async () => {
    // Opened by vault.Opener with the fixed key above (Go 1.27.1, 2026-10-01).
    expect(
      await sealSecret(KEYD_PUBLIC, weather, VALUE, { ephemeral: EPHEMERAL, nonce: NONCE }),
    ).toEqual({
      v: 1,
      epk: "BLhfkHvMwLU1VR2xt2QbapafF0HZL1U_EABDIa8GocmgFNZqvKrR0ZinBw_bbXXvp1tZIDoT8KptqEj3qt86wj0",
      nonce: "AAECAwQFBgcICQoL",
      ct: "wpSd7tLllnTJVPphF6Utcgorgp-jGSSn9dEwVhuXCcB6rJ_hpNaF",
    });
    expect(
      (await sealSecret(KEYD_PUBLIC, groq, VALUE, { ephemeral: EPHEMERAL, nonce: NONCE })).ct,
    ).toBe("wpSd7tLllnTJVPphF6Utcgorgp-jGSRMDJgiVN_r58h6FkhSL0r3");
  });

  it("opens what keyd's own tests sealed, so both sides agree on the format", async () => {
    const fromGoTests: [SecretBinding, Sealed][] = [
      [
        { id: "anthropic", kind: "llm", provider: "anthropic" },
        {
          v: 1,
          epk: "BDRBSHmompILZT4JXnwFw_aLRlQBykzXvyaBUZKuUZHkfbY1Hi_0x2xLVFEhKRT3RBSwEKdH7ofgaQaMkb1E_-4",
          nonce: "RcWTiYUMWlwdbPpo",
          ct: "eSbQx0PjBEKB5huMwBy6TF0BeOiziJjeNgrtcGcDXzKjeAqbRAcR",
        },
      ],
      [
        weather,
        {
          v: 1,
          epk: "BCghCEuuHBof4xoiFZ9-spP370ghtOh8IKmtP_zyqo34vqD9IbiojExBy3YylZssk48g6qJiST45EKz289oeRzY",
          nonce: "FgtfN8Eg8teW7BSf",
          ct: "G_0PaqZmmO-YCxm4CHC4lqox8u2JRzw7GckBNM6B3LCBKr0Ywfqk",
        },
      ],
    ];
    for (const [binding, sealed] of fromGoTests) expect(await open(sealed, binding)).toBe(VALUE);
  });

  it("seals with a fresh key and nonce every time, bound to the whole binding", async () => {
    const a = await sealSecret(KEYD_PUBLIC, weather, VALUE);
    const b = await sealSecret(KEYD_PUBLIC, weather, VALUE);
    expect(a.epk).not.toBe(b.epk);
    expect(a.nonce).not.toBe(b.nonce);
    expect(await open(a, weather)).toBe(VALUE);
    const elsewhere: SecretBinding = { ...weather, hosts: [...weather.hosts, "evil.example.test"] };
    await expect(open(a, elsewhere)).rejects.toThrow();
    await expect(open(a, { ...weather, id: "other" })).rejects.toThrow();
    await expect(open(a, { ...weather, methods: undefined })).rejects.toThrow();
  });

  it("never puts the value in the sealed fields", async () => {
    const sealed = await sealSecret(KEYD_PUBLIC, groq, VALUE);
    expect(JSON.stringify(sealed)).not.toContain(VALUE);
    expect(JSON.stringify(sealed)).not.toContain(btoa(VALUE).replace(/=+$/, ""));
  });
});

describe("sealPassphrase", () => {
  it("produces the vector keyd's Go opener opens as a passphrase", async () => {
    // Opened by vault.Opener.OpenPassphrase with the fixed key above (Go 1.27.1, 2026-10-09).
    expect(
      await sealPassphrase(KEYD_PUBLIC, "correct horse battery staple", {
        ephemeral: EPHEMERAL,
        nonce: NONCE,
      }),
    ).toEqual({
      v: 1,
      epk: "BLhfkHvMwLU1VR2xt2QbapafF0HZL1U_EABDIa8GocmgFNZqvKrR0ZinBw_bbXXvp1tZIDoT8KptqEj3qt86wj0",
      nonce: "AAECAwQFBgcICQoL",
      ct: "x5qE-Zrthy2MXfp9H6g4dhw8lZSqTTgHt9KIc5G4L85WNugGGb1NWeN4Rv0",
    });
  });

  it("does not open as any secret", async () => {
    const sealed = await sealPassphrase(KEYD_PUBLIC, VALUE);
    await expect(open(sealed, weather)).rejects.toThrow();
    await expect(open(sealed, groq)).rejects.toThrow();
  });
});

describe("bindingJson", () => {
  it("writes the AAD array exactly as keyd's Go encoder does for printable ASCII", () => {
    // Go: json.Encoder with SetEscapeHTML(false) printed this line for the same record.
    expect(
      bindingJson({
        id: "weather",
        kind: "http",
        hosts: ["api.example.test"],
        header: "Authorization",
        format: "raw",
        paths: ['/a&b<c>/"q"/\\\'~'],
      }),
    ).toBe(
      String.raw`["weather","http","","",["api.example.test"],"Authorization","raw",[],["/a&b<c>/\"q\"/\\'~"]]`,
    );
    expect(bindingJson(groq)).toBe(
      '["groq","llm","openai-compatible","https://api.groq.com/openai/v1",[],"","",[],[]]',
    );
  });

  it("refuses text Go would escape differently, naming the field", () => {
    const lineSeparator = String.fromCodePoint(0x2028);
    expect(() =>
      bindingJson({ ...groq, baseURL: `https://e.example/p${lineSeparator}q` } as SecretBinding),
    ).toThrow(BindingTextError);
    expect(() => bindingJson({ ...weather, hosts: ["bücher.example"] })).toThrow(
      "hosts must be printable ASCII",
    );
    expect(() => bindingJson({ ...weather, header: "X\tKey" })).toThrow(
      "header must be printable ASCII",
    );
  });

  it("is what new URL(x).href makes of a base URL with non-ASCII text", () => {
    const href = new URL(`https://bücher.example/v1/${String.fromCodePoint(0x2028)}`).href;
    expect(href).toBe("https://xn--bcher-kva.example/v1/%E2%80%A8");
    expect(() => bindingJson({ ...groq, baseURL: href } as SecretBinding)).not.toThrow();
  });
});
