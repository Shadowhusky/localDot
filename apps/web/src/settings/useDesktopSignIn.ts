import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { dismissToast, showToast } from "../ui/Toast.tsx";
import { desktopSignIn } from "./accounts-api.ts";

export const DESKTOP_SIGN_IN_EVERY_MS = 4000;
const TOAST = "desktop-sign-in";
const FAILED = "desktop-sign-in-failed";

// While the user works on the desktop, a sign-in page in its own browser, which keeps no sign-ins,
// brings a calm toast offering the site in the web browser. With a task on the computer, dot is the
// one to ask.
export function useDesktopSignIn({
  api,
  cellId,
  watching,
  offer,
}: {
  api: ApiClient;
  cellId: string | null;
  watching: boolean;
  offer?(site: string, failed: (message: string) => void): void;
}): void {
  const [site, setSite] = useState<string | null>(null);
  const latest = useRef(offer);
  latest.current = offer;
  const offered = !!offer;

  useEffect(() => {
    if (!watching || !cellId) {
      setSite(null);
      return;
    }
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = async () => {
      if (!document.hidden) {
        try {
          const found = await desktopSignIn(api, cellId, abort.signal);
          if (!abort.signal.aborted) setSite(found);
        } catch {
          // The next look tries again; a failed one says nothing.
        }
      }
      if (!abort.signal.aborted) timer = setTimeout(look, DESKTOP_SIGN_IN_EVERY_MS);
    };
    void look();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [api, cellId, watching]);

  useEffect(() => {
    if (!site) {
      dismissToast(TOAST);
      return;
    }
    showToast({
      id: TOAST,
      icon: "globe",
      title: "Sign-ins here aren't kept",
      description: offered
        ? `Open ${site} in localDot's web browser to stay signed in.`
        : `When you hand back, ask dot to sign in to ${site} in the web browser.`,
      ...(offered
        ? {
            action: {
              label: "Open in web browser",
              onAction: () =>
                latest.current?.(site, (message) =>
                  showToast({
                    id: FAILED,
                    tone: "danger",
                    title: `Couldn't open ${site}`,
                    description: message,
                  }),
                ),
            },
          }
        : {}),
    });
  }, [site, offered]);

  useEffect(() => () => dismissToast(TOAST), []);
}
