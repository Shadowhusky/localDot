import {
  clipText,
  type HairpinGuard,
  KeydRecord,
  type KeydVault,
  SECRET_ID_PATTERN,
  type Sealed,
  SecretBinding,
  sealSecret,
} from "@localdot/protocol";
import { z } from "zod";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { valueProblem } from "./binding.ts";

export interface KeydHealth {
  online: boolean;
  bootId?: string;
  sealKey?: string;
  audit?: { ok: boolean; error?: string };
  hairpin?: HairpinGuard;
  // How many keys need entering again.
  reenter?: number;
  // How many keys were changed outside localDot.
  rebound?: number;
  // Off macOS: where saved keys live, and whether they wait for localdot unlock.
  vault?: KeydVault;
  error?: string;
}

export const UNLOCK = "localdot unlock";
export const VAULT_LOCKED = `Saved keys are locked. On that computer, run: ${UNLOCK}`;

// Where saved keys live: the Keychain only for the signed Mac release; otherwise keyd's own vault
// on the computer running localDot, which may not be the one showing this page.
export function keyHome(health: KeydHealth | null): string {
  switch (health?.vault?.backend) {
    case "keychain":
      return "in your Mac's keychain";
    case "secret-service":
      return "in the keyring of the computer running localDot";
    case "file":
      return "encrypted on the computer running localDot";
    default:
      return "on the computer running localDot";
  }
}

export const vaultLocked = (health: KeydHealth | null) =>
  health?.online === true && (health.vault?.state === "locked" || health.vault?.state === "setup");

export interface KeyRecord {
  id: string;
  kind: "llm" | "http";
  provider?: string;
  baseURL?: string;
  hosts?: string[] | null;
  header?: string;
  format?: string;
  methods?: string[] | null;
  paths?: string[] | null;
  createdAt: string;
  updatedAt: string;
  // The stored value is gone or can't be read as stored, so it has to be entered again.
  reenter?: boolean;
  // Where it is sent was changed outside localDot after it was stored, so it is removed and added
  // again rather than entered again.
  rebound?: boolean;
}

export type Seal = (publicKey: string, binding: SecretBinding, value: string) => Promise<Sealed>;

export class KeyProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyProblem";
  }
}

export const loadHealth = (api: ApiClient) => api.get<KeydHealth>("/api/keyd");

export async function loadKeys(api: ApiClient): Promise<KeyRecord[]> {
  return (await api.get<{ keys: KeyRecord[] }>("/api/keys")).keys;
}

// Seals the value to keyd's current boot key and hands the daemon only the binding and the
// ciphertext. keyd answers 409 bad-seal when it restarted (new boot key) after the seal key was
// read: the value is sealed once more to the new key.
export async function saveKey(
  api: ApiClient,
  binding: SecretBinding,
  value: string,
  seal: Seal = sealSecret,
): Promise<{ key: KeyRecord; restart: boolean }> {
  // Snapshot the allowed fields before any await. The form may change while
  // sealing, and TypeScript alone cannot keep extra runtime fields off the wire.
  const checked = SecretBinding.safeParse(binding);
  if (!checked.success) throw new KeyProblem("Check the key's name and where it can be used.");
  const problem = valueProblem(value);
  if (problem) throw new KeyProblem(problem);
  const bound = checked.data;
  const send = async () => {
    const health = await loadHealth(api);
    if (!health.online || !health.sealKey)
      throw new KeyProblem("Key protection is off, so the key wasn't saved.");
    const sealed = await seal(health.sealKey, bound, value);
    const raw = await api.post<unknown>("/api/keys", { binding: bound, sealed });
    const parsed = z
      .object({
        restart: z.boolean(),
        key: KeydRecord.extend({
          id: z.string().regex(SECRET_ID_PATTERN),
          provider: z.string().max(64).optional(),
          baseURL: z.string().max(2048).optional(),
          createdAt: z.string().max(64),
          updatedAt: z.string().max(64),
        }),
      })
      .safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.key.id !== bound.id ||
      parsed.data.key.kind !== bound.kind ||
      (bound.kind === "llm" && parsed.data.key.provider !== bound.provider)
    )
      throw new KeyProblem(
        "The saved key reply could not be verified. Reload Keys before retrying.",
      );
    return parsed.data;
  };
  try {
    return await send();
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && errorCode(err) === "bad-seal")
      return send();
    throw err;
  }
}

export const deleteKey = (api: ApiClient, id: string) =>
  api.del(`/api/keys/${encodeURIComponent(id)}`);

// The daemon's refusals are `{ error, message }`; anything else becomes one plain sentence.
export function problemText(err: unknown): string {
  if (err instanceof KeyProblem) return err.message;
  if (lockedVaultError(err)) return VAULT_LOCKED;
  if (err instanceof ApiError) {
    const body = parse(err.message);
    if (body?.message) return sentence(body.message);
    if (err.status === 503) return "Key protection is off, so the key wasn't saved.";
  }
  return "Something went wrong saving the key. Try again.";
}

export const lockedVaultError = (err: unknown) =>
  err instanceof ApiError && err.status === 423 && errorCode(err) === "vault-locked";

function errorCode(err: unknown): string | undefined {
  return err instanceof ApiError ? parse(err.message)?.error : undefined;
}

function parse(text: string): { error?: string; message?: string } | undefined {
  try {
    const body = JSON.parse(text) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
    const fields = body as Record<string, unknown>;
    return {
      error: typeof fields.error === "string" ? fields.error : undefined,
      message: typeof fields.message === "string" ? fields.message : undefined,
    };
  } catch {
    return undefined;
  }
}

function sentence(text: string): string {
  const t = clipText(text, 512)
    .trim()
    .replace(/^keys: /, "");
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? "" : "."}`;
}
