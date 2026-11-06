import {
  type CatalogEntry,
  type ConnectorDraft,
  type ConnectorPatch,
  ConnectorView,
  connectorSecretId,
  type HttpBinding,
} from "@localdot/protocol";
import { z } from "zod";
import { saveKey } from "../keys/keys-api.ts";
import { type ApiClient, ApiError } from "../lib/api.ts";

export interface ConnectorsList {
  connectors: ConnectorView[];
  catalog: readonly CatalogEntry[];
}

const Listed = z.object({
  connectors: z.array(ConnectorView),
  catalog: z.array(z.custom<CatalogEntry>((value) => !!value && typeof value === "object")),
});
const One = z.object({ connector: ConnectorView });

const path = (id: string, rest = "") => `/api/connectors/${encodeURIComponent(id)}${rest}`;

export async function loadConnectors(
  api: ApiClient,
  signal?: AbortSignal,
): Promise<ConnectorsList> {
  return Listed.parse(await api.get("/api/connectors", signal ? { signal } : undefined));
}

export async function addConnector(api: ApiClient, draft: ConnectorDraft): Promise<ConnectorView> {
  return One.parse(await api.post("/api/connectors", draft)).connector;
}

export async function updateConnector(
  api: ApiClient,
  id: string,
  patch: ConnectorPatch,
): Promise<ConnectorView> {
  return One.parse(await api.put(path(id), patch)).connector;
}

export async function refreshConnector(api: ApiClient, id: string): Promise<ConnectorView> {
  return One.parse(await api.post(path(id, "/refresh"))).connector;
}

export function removeConnector(api: ApiClient, id: string): Promise<void> {
  return api.del(path(id));
}

const SignInStarted = z.object({
  opened: z.boolean(),
  url: z.url().optional(),
  expiresAt: z.number(),
  remote: z.boolean(),
});
export type SignInStarted = z.infer<typeof SignInStarted>;

// The daemon opens the app's sign-in page in the browser on its own computer.
export async function startSignIn(api: ApiClient, id: string): Promise<SignInStarted> {
  return SignInStarted.parse(await api.post(path(id, "/sign-in")));
}

export function cancelSignIn(api: ApiClient, id: string): Promise<void> {
  return api.del(path(id, "/sign-in"));
}

export async function disconnectConnector(api: ApiClient, id: string): Promise<ConnectorView> {
  return One.parse(await api.post(path(id, "/disconnect"))).connector;
}

// A connector's key, sealed in this page to keyd and bound to where the app sends it.
export function saveConnectorKey(
  api: ApiClient,
  connectorId: string,
  where: { hosts: readonly string[]; header: string; format: "bearer" | "raw" },
  value: string,
) {
  const binding: z.infer<typeof HttpBinding> = {
    id: connectorSecretId(connectorId),
    kind: "http",
    hosts: [...where.hosts],
    header: where.header.toLowerCase(),
    format: where.format,
  };
  return saveKey(api, binding, value);
}

// The daemon's words for what went wrong, or a plain fallback.
export function problemOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    try {
      const { message } = JSON.parse(error.message) as { message?: unknown };
      if (typeof message === "string" && message) return message;
    } catch {
      // Not JSON: the fallback reads better than a status line.
    }
  }
  if (error instanceof Error && error.name === "KeyProblem") return error.message;
  return fallback;
}
