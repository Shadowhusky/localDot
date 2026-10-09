import { useCallback, useEffect, useRef, useState } from "react";
import type { SignInSite } from "../../../../packages/protocol/src/accounts.ts";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { clearSignIns, listSignIns, signOutOf } from "./accounts-api.ts";

// While the web browser starts, the list is asked for again this often, a few times.
export const STARTING_RETRY_MS = 3000;
const STARTING_RETRIES = 20;

export type AccountsPhase = "loading" | "ready" | "off" | "starting" | "error";

export interface AccountsView {
  phase: AccountsPhase;
  sites: readonly SignInSite[];
  // The site being signed out of, or "*" while every sign-in is cleared.
  pending: string | null;
  failure: string | null;
  reload(): void;
  signOut(site: string): void;
  clearAll(): Promise<boolean>;
}

function phaseOf(error: unknown): AccountsPhase {
  if (error instanceof ApiError)
    return error.status === 409 ? "off" : error.status === 503 ? "starting" : "error";
  return error instanceof DOMException ? "starting" : "error";
}

export function useAccounts(api: ApiClient, cellId: string | null, visible: boolean): AccountsView {
  const [phase, setPhase] = useState<AccountsPhase>("loading");
  const [sites, setSites] = useState<readonly SignInSite[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retries = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt is what asks again
  useEffect(() => {
    if (!visible) return;
    if (!cellId) {
      setPhase("off");
      return;
    }
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    listSignIns(api, cellId, abort.signal).then(
      (found) => {
        retries.current = 0;
        setSites(found);
        setPhase("ready");
      },
      (error: unknown) => {
        if (abort.signal.aborted) return;
        const next = phaseOf(error);
        setPhase(next);
        if (next === "starting" && retries.current++ < STARTING_RETRIES)
          timer = setTimeout(() => setAttempt((value) => value + 1), STARTING_RETRY_MS);
      },
    );
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [api, cellId, visible, attempt]);

  const reload = useCallback(() => {
    retries.current = 0;
    setFailure(null);
    setAttempt((value) => value + 1);
  }, []);

  const signOut = useCallback(
    (site: string) => {
      if (!cellId) return;
      setPending(site);
      setFailure(null);
      signOutOf(api, cellId, site)
        .then(setSites, (error: unknown) => {
          setFailure(
            error instanceof ApiError && error.status === 404
              ? null
              : `Couldn't sign out of ${site}. Try again.`,
          );
          if (error instanceof ApiError && error.status === 404)
            setSites((current) => current.filter((entry) => entry.site !== site));
        })
        .finally(() => setPending(null));
    },
    [api, cellId],
  );

  const clearAll = useCallback(async () => {
    setPending("*");
    setFailure(null);
    try {
      await clearSignIns(api);
      setSites([]);
      return true;
    } catch {
      setFailure("Couldn't sign out of every site. Try again.");
      return false;
    } finally {
      setPending(null);
    }
  }, [api]);

  return { phase, sites, pending, failure, reload, signOut, clearAll };
}
