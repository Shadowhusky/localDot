import { PRINTABLE_ASCII, type Sealed, type SecretBinding } from "./keyd.ts";

// keyd's seal v1 (Part 4a, vault/seal.go): ECDH P-256 with an ephemeral key, HKDF-SHA256 over the
// shared secret (salt = ephemeral public key || keyd public key, info = SEAL_INFO), AES-256-GCM
// with the secret's whole binding in the AAD, so a sealed value opens only under its binding.
export const SEAL_INFO = "localdot-keyd seal v1";

export class BindingTextError extends Error {
  constructor(readonly field: string) {
    super(`${field} must be printable ASCII`);
    this.name = "BindingTextError";
  }
}

// The AAD's JSON, byte for byte what keyd's Go encoder writes. Go escapes U+2028, U+2029 and
// invalid UTF-8 where JSON.stringify does not, so anything but printable ASCII is refused here
// (a base URL goes through new URL(x).href first, which encodes it as ASCII).
export function bindingJson(binding: SecretBinding): string {
  const http = binding.kind === "http" ? binding : undefined;
  const llm = binding.kind === "llm" ? binding : undefined;
  const fields: [string, string | string[]][] = [
    ["id", binding.id],
    ["kind", binding.kind],
    ["provider", llm?.provider ?? ""],
    ["baseURL", llm?.baseURL ?? ""],
    ["hosts", http?.hosts ?? []],
    ["header", http?.header ?? ""],
    ["format", http?.format ?? ""],
    ["methods", http?.methods ?? []],
    ["paths", http?.paths ?? []],
  ];
  for (const [name, value] of fields) {
    for (const text of typeof value === "string" ? [value] : value) {
      if (!PRINTABLE_ASCII.test(text)) throw new BindingTextError(name);
    }
  }
  return JSON.stringify(fields.map(([, value]) => value));
}

export interface EcPrivateJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  d: string;
}

// Tests pin the ephemeral key and the nonce to compare against a vector keyd opens; in use both
// are fresh for every seal.
export interface SealOptions {
  ephemeral?: EcPrivateJwk;
  nonce?: Uint8Array<ArrayBuffer>;
}

export function sealSecret(
  publicKey: string,
  binding: SecretBinding,
  value: string,
  opts: SealOptions = {},
): Promise<Sealed> {
  return seal(publicKey, utf8(`${SEAL_INFO}:${bindingJson(binding)}`), value, opts);
}

// A key vault passphrase seals under an AAD no binding has (a binding's JSON starts with "["), so
// keyd never opens a passphrase as a secret or a secret as a passphrase.
export function sealPassphrase(
  publicKey: string,
  passphrase: string,
  opts: SealOptions = {},
): Promise<Sealed> {
  return seal(publicKey, utf8(`${SEAL_INFO}:vault-passphrase`), passphrase, opts);
}

async function seal(
  publicKey: string,
  aad: Uint8Array<ArrayBuffer>,
  value: string,
  opts: SealOptions,
): Promise<Sealed> {
  const { subtle } = globalThis.crypto;
  const keydRaw = fromBase64url(publicKey);
  const keyd = await subtle.importKey(
    "raw",
    keydRaw,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const pair = opts.ephemeral
    ? {
        privateKey: await subtle.importKey(
          "jwk",
          opts.ephemeral,
          { name: "ECDH", namedCurve: "P-256" },
          false,
          ["deriveBits"],
        ),
        raw: rawPoint(opts.ephemeral),
      }
    : await freshPair();
  const shared = await subtle.deriveBits({ name: "ECDH", public: keyd }, pair.privateKey, 256);
  const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: concat(pair.raw, keydRaw), info: utf8(SEAL_INFO) },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const nonce = opts.nonce ?? globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad },
    key,
    utf8(value),
  );
  return {
    v: 1,
    epk: toBase64url(pair.raw),
    nonce: toBase64url(nonce),
    ct: toBase64url(new Uint8Array(ct)),
  };
}

async function freshPair() {
  const { subtle } = globalThis.crypto;
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  return {
    privateKey: pair.privateKey,
    raw: new Uint8Array(await subtle.exportKey("raw", pair.publicKey)),
  };
}

function rawPoint(jwk: EcPrivateJwk): Uint8Array<ArrayBuffer> {
  return concat(new Uint8Array([4]), fromBase64url(jwk.x), fromBase64url(jwk.y));
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
