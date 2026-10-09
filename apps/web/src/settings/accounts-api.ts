import { TakeComputerReply, ULID_PATTERN } from "@localdot/protocol";
import {
  DesktopSignIn,
  SignInRequest,
  type SignInSite,
  SignInSites,
  SignOutRequest,
} from "../../../../packages/protocol/src/accounts.ts";
import { controlRequest } from "../agent/control-api.ts";
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

// The web browser opens the site's sign-in page and the user takes the computer there. Starting
// the web browser can outlast the request; the computer then hands it over when it is ready.
export function signInTo(
  api: ApiClient,
  cellId: string,
  site: string,
  signal: AbortSignal,
): Promise<TakeComputerReply> {
  return controlRequest(
    api,
    `${root(cellId)}/sign-in`,
    SignInRequest.parse({ site }),
    202,
    signal,
    (text) => TakeComputerReply.parse(JSON.parse(text)),
  );
}

export async function desktopSignIn(
  api: ApiClient,
  cellId: string,
  signal: AbortSignal,
): Promise<string | null> {
  if (!ULID_PATTERN.test(cellId)) throw new Error("Invalid computer.");
  return DesktopSignIn.parse(await api.get(`/api/cells/${cellId}/desktop-sign-in`, { signal }))
    .site;
}
