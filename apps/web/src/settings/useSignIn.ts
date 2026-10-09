import { useCallback, useRef, useState } from "react";
import { signInSite } from "../../../../packages/protocol/src/accounts.ts";
import { ControlFailure } from "../agent/control-api.ts";
import type { ApiClient } from "../lib/api.ts";
import { signInTo } from "./accounts-api.ts";

export interface SignInView {
  // The site whose sign-in page is opening.
  pending: string | null;
  failure: string | null;
  // False when nothing opened; true once the web browser is on its way.
  start(site: string): Promise<boolean>;
  clear(): void;
}

export function signInFailure(error: unknown): string {
  const status = error instanceof ControlFailure ? error.status : undefined;
  return status === 409
    ? "dot is using your computer. Sign in when it's done, or ask dot to open the site."
    : status === 400
      ? "That isn't a site the web browser can open."
      : status === 502 || status === 503
        ? "The web browser couldn't open. Try again in a moment."
        : "Couldn't open the site. Try again.";
}

// Opens a site's sign-in page in the web browser with the user in control; `opened` runs once the
// computer has it, or while the web browser is still starting, so the page can show it.
export function useSignIn(
  api: ApiClient,
  cellId: string | null,
  opened: (site: string) => void,
): SignInView {
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const busy = useRef(false);
  const latest = useRef(opened);
  latest.current = opened;
  const start = useCallback(
    async (typed: string) => {
      const site = signInSite(typed);
      if (busy.current) return false;
      if (!site) {
        setFailure(
          typed.trim()
            ? "The web browser opens public sites only, like google.com."
            : "Enter a site, like google.com.",
        );
        return false;
      }
      if (!cellId) {
        setFailure("Turn on your computer first.");
        return false;
      }
      busy.current = true;
      setPending(site);
      setFailure(null);
      try {
        await signInTo(api, cellId, site, new AbortController().signal);
        latest.current(site);
        return true;
      } catch (error) {
        // A reply that never came may only mean the web browser is still starting.
        if (error instanceof ControlFailure && error.uncertain && error.status === undefined) {
          latest.current(site);
          return true;
        }
        setFailure(signInFailure(error));
        return false;
      } finally {
        busy.current = false;
        setPending(null);
      }
    },
    [api, cellId],
  );
  const clear = useCallback(() => setFailure(null), []);
  return { pending, failure, start, clear };
}
