import {
  LoginImport,
  MAX_EXPORT_BYTES,
  SavedLogin,
  SavedLogins,
  type Sealed,
  sealLogin,
  sealLoginImport,
} from "@localdot/protocol";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { KeyProblem, loadHealth, lockedVaultError, VAULT_LOCKED } from "./keys-api.ts";

// An export takes keyd a few Keychain writes a login.
const IMPORT_WAIT_MS = 10 * 60_000;
const UPDATE_FIRST = "Update localDot key protection to save logins.";
const OFFLINE = "Key protection is off, so nothing was saved.";

export class ImportUnconfirmed extends Error {
  constructor() {
    super("The import's answer was lost.");
    this.name = "ImportUnconfirmed";
  }
}

export async function loadLogins(api: ApiClient): Promise<SavedLogin[]> {
  return SavedLogins.parse(await api.get("/api/logins")).logins;
}

const sealKeyForLogins = async (api: ApiClient) => {
  const health = await loadHealth(api);
  if (!health.online || !health.sealKey) throw new KeyProblem(OFFLINE);
  if (!health.savedLogins) throw new KeyProblem(UPDATE_FIRST);
  return health.sealKey;
};

// Sealed to keyd's current boot key in this page, so the daemon relays only ciphertext; keyd answers
// bad-seal when it restarted after the key was read, and the login is sealed once more.
async function sealedAgain<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && errorCode(err) === "bad-seal")
      return work();
    throw err;
  }
}

// Without a password it changes only the account saved for that site.
export function saveLogin(
  api: ApiClient,
  login: { origin: string; username: string; password?: string },
): Promise<SavedLogin> {
  const given = { ...login };
  return sealedAgain(async () => {
    const sealed = await sealLogin(await sealKeyForLogins(api), given);
    const reply = await api.post<{ login: unknown }>("/api/logins", { sealed });
    return SavedLogin.parse(reply.login);
  });
}

export const removeLogin = (api: ApiClient, origin: string) =>
  api.del(`/api/logins/${encodeURIComponent(origin)}`);

// The file's bytes are read here, sealed to keyd and wiped: only keyd ever reads them, and neither
// this page nor the daemon keeps a copy or a name.
export async function importLogins(api: ApiClient, file: File): Promise<LoginImport> {
  if (file.size > MAX_EXPORT_BYTES)
    throw new KeyProblem("This file is too big to be a password export. Export only your logins.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return await sealedAgain(async () =>
      send(api, await sealLoginImport(await sealKeyForLogins(api), bytes)),
    );
  } finally {
    bytes.fill(0);
  }
}

async function send(api: ApiClient, sealed: Sealed): Promise<LoginImport> {
  let reply: Response;
  try {
    reply = await api.fetch(`${api.socketUrl("").replace(/^ws/, "http")}/api/logins/import`, {
      method: "POST",
      headers: { authorization: api.authorization(), "content-type": "application/json" },
      body: JSON.stringify({ sealed }),
      signal: AbortSignal.timeout(IMPORT_WAIT_MS),
    });
  } catch {
    throw new ImportUnconfirmed();
  }
  if (reply.status === 401) {
    api.rejectUnauthorized?.();
    throw new ApiError(401, "unauthorized");
  }
  const text = await reply.text();
  if (!reply.ok) throw new ApiError(reply.status, text || reply.statusText);
  return LoginImport.parse(JSON.parse(text));
}

export function loginProblem(err: unknown, otherwise: string): string {
  if (err instanceof KeyProblem) return err.message;
  if (err instanceof ImportUnconfirmed)
    return "Couldn't confirm the import. It may still be running, so your list may fill in by itself.";
  if (lockedVaultError(err)) return VAULT_LOCKED;
  if (err instanceof ApiError) {
    if (errorCode(err) === "not-an-export")
      return "This file doesn't look like a password export. Export your logins as CSV, then try again.";
    if (err.status === 413) return "This file is too big to be a password export.";
    if (err.status === 503) return OFFLINE;
  }
  return otherwise;
}

function errorCode(err: ApiError): string | undefined {
  try {
    const body = JSON.parse(err.message) as { error?: unknown };
    return typeof body.error === "string" ? body.error : undefined;
  } catch {
    return undefined;
  }
}
