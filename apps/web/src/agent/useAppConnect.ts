import type { ConnectorView } from "@localdot/protocol";
import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import {
  cancelSignIn,
  loadConnectors,
  problemOf,
  startSignIn,
} from "../settings/connectors-api.ts";
import { signInOf } from "../settings/connectors-form.ts";

const POLL_MS = 2000;

function isConnected(view: ConnectorView): boolean {
  return Boolean(signInOf(view)?.signedIn) && !view.signIn && view.status !== "needs_sign_in";
}

// One app's sign-in from a card: the same one click as in Settings. It opens in the browser on the
// Mac, and this watches from the moment the card shows, since another surface may have it under way.
export function useAppConnect({
  api,
  connector,
  onConnected,
  onGaveUp,
}: {
  api?: ApiClient | null;
  connector?: string;
  onConnected(): void | Promise<void>;
  // A sign-in started here ended without connecting, or couldn't start.
  onGaveUp?(): void;
}) {
  const alive = useRef(true);
  // A sign-in started since a check began makes what that check saw out of date.
  const starts = useRef(0);
  const waited = useRef(false);
  const told = useRef(onConnected);
  told.current = onConnected;
  const gaveUp = useRef(onGaveUp);
  gaveUp.current = onGaveUp;
  const [starting, setStarting] = useState(false);
  const [waiting, setWaiting] = useState<{ remote: boolean; page?: string } | undefined>();
  const [problem, setProblem] = useState("");
  useEffect(() => {
    waited.current = !!waiting;
  }, [waiting]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!api || !connector) return;
    let stopped = false;
    const check = async () => {
      const asked = starts.current;
      const list = await loadConnectors(api).catch(() => undefined);
      const view = list?.connectors.find((each) => each.id === connector);
      if (stopped || !alive.current || !view || asked !== starts.current) return;
      if (isConnected(view)) {
        stopped = true;
        clearInterval(timer);
        setWaiting(undefined);
        await told.current();
      } else if (view.signIn) {
        const { remote } = view.signIn;
        setWaiting((now) => now ?? { remote });
      } else if (waited.current) {
        waited.current = false;
        setWaiting(undefined);
        setProblem(view.problem ?? "It didn't finish connecting. Try again.");
        gaveUp.current?.();
      }
    };
    const timer = setInterval(() => void check(), POLL_MS);
    void check();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [api, connector]);
  const connect = async () => {
    if (!api || !connector || starting) return;
    starts.current += 1;
    setStarting(true);
    setProblem("");
    try {
      const started = await startSignIn(api, connector);
      if (alive.current)
        setWaiting({ remote: started.remote, ...(started.url ? { page: started.url } : {}) });
    } catch (error) {
      gaveUp.current?.();
      if (alive.current) setProblem(problemOf(error, "Couldn't open the sign-in. Try again."));
    } finally {
      if (alive.current) setStarting(false);
    }
  };
  const cancel = () => {
    if (waiting && api && connector) void cancelSignIn(api, connector).catch(() => {});
    if (waiting) gaveUp.current?.();
    setWaiting(undefined);
  };
  return { connect, cancel, starting, waiting, problem };
}
