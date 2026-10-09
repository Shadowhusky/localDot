import { ULID_PATTERN } from "@localdot/protocol";
import {
  type SignInSite,
  SignInSites,
  SignOutRequest,
} from "../../../../packages/protocol/src/accounts.ts";
import type { ApiClient } from "../lib/api.ts";

function root(cellId: string): string {
  if (!ULID_PATTERN.test(cellId)) throw new Error("Invalid computer.");
  return `/api/cells/${cellId}/accounts`;
}

export async function listSignIns(
  api: ApiClient,
  cellId: string,
  signal: AbortSignal,
): Promise<SignInSite[]> {
  return SignInSites.parse(await api.get(root(cellId), { signal })).sites;
}

export async function signOutOf(
  api: ApiClient,
  cellId: string,
  site: string,
): Promise<SignInSite[]> {
  const body = SignOutRequest.parse({ site });
  return SignInSites.parse(await api.post(`${root(cellId)}/sign-out`, body)).sites;
}

export async function clearSignIns(api: ApiClient): Promise<void> {
  SignInSites.parse(await api.post("/api/accounts/clear"));
}
