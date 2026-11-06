import type { ConnectorView } from "@localdot/protocol";
import { useEffect, useRef, useState } from "react";
import {
  cancelSignIn,
  loadConnectors,
  problemOf,
  startSignIn,
} from "../settings/connectors-api.ts";
import { signInOf } from "../settings/connectors-form.ts";
import { Button } from "../ui/Button.tsx";
import type { AskFormProps } from "./AskForm.tsx";
import { useAskState } from "./ask-draft.ts";

const POLL_MS = 2000;

function isConnected(view: ConnectorView): boolean {
  return Boolean(signInOf(view)?.signedIn) && !view.signIn && view.status !== "needs_sign_in";
}

// dot's offer to connect an app, in the conversation. The same one click as in Settings: the sign-in
// opens in the browser on the Mac, this card waits, and dot carries on once the app is connected.
export function AppConnectRequest({ draft, answer, reason, connectApi: api }: AskFormProps) {
  const field = draft.fields[0];
  const app = field?.connect;
  const state = useAskState(draft);
  const alive = useRef(true);
  // A sign-in started since a check began makes what that check saw out of date.
  const starts = useRef(0);
  const waited = useRef(false);
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
  // From the moment it shows: another surface, or Settings, may have the sign-in under way already.
  useEffect(() => {
    if (!api || !app || !field) return;
    let stopped = false;
    const check = async () => {
      const asked = starts.current;
      const list = await loadConnectors(api).catch(() => undefined);
      const view = list?.connectors.find((each) => each.id === app.connector);
      if (stopped || !alive.current || !view || asked !== starts.current) return;
      if (isConnected(view)) {
        stopped = true;
        clearInterval(timer);
        setWaiting(undefined);
        draft.set(field.id, true);
        await draft.submit(answer);
      } else if (view.signIn) {
        const { remote } = view.signIn;
        setWaiting((now) => now ?? { remote });
      } else if (waited.current) {
        setWaiting(undefined);
        setProblem(view.problem ?? "It didn't finish connecting. Try again.");
      }
    };
    const timer = setInterval(() => void check(), POLL_MS);
    void check();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [api, app, field, draft, answer]);
  if (!app || !field)
    return <p role="alert">This offer is incomplete. Ask dot to check the app's settings.</p>;
  const connect = async () => {
    if (!api || starting) return;
    starts.current += 1;
    setStarting(true);
    setProblem("");
    try {
      const started = await startSignIn(api, app.connector);
      if (alive.current)
        setWaiting({ remote: started.remote, ...(started.url ? { page: started.url } : {}) });
    } catch (error) {
      if (alive.current) setProblem(problemOf(error, "Couldn't open the sign-in. Try again."));
    } finally {
      if (alive.current) setStarting(false);
    }
  };
  const verb = app.reconnect ? "Reconnect" : "Connect";
  return (
    <section aria-label={`${verb} ${app.name}`} className="private-key-request keys-form">
      <p className="private-key-title">{app.name}</p>
      <p className="private-key-destination">{app.host}</p>
      <p>
        {waiting
          ? waiting.remote
            ? "The sign-in opened in the browser on your Mac, where your accounts are. It can't be finished from this device."
            : `Approve ${app.name} in your browser. dot carries on when you're done.`
          : "You approve it in your browser. dot gets the app's tools and never sees this sign-in."}
      </p>
      {waiting?.page && (
        <p>
          <a href={waiting.page} target="_blank" rel="noopener noreferrer">
            Open the sign-in page
          </a>
        </p>
      )}
      {(problem || state.failed) && <p role="alert">{problem || state.failed}</p>}
      <div className="keys-actions">
        <Button
          variant="quiet"
          disabledReason={state.sending ? "Continuing task" : reason}
          onClick={() => {
            if (waiting && api) void cancelSignIn(api, app.connector).catch(() => {});
            setWaiting(undefined);
            void draft.decline(answer);
          }}
        >
          Not now
        </Button>
        <Button
          variant="primary"
          busy={starting}
          disabledReason={
            reason ??
            (state.sending ? "Continuing task" : undefined) ??
            (!api ? "Connecting apps is unavailable here" : undefined)
          }
          onClick={() => void connect()}
        >
          {waiting ? "Open again" : verb}
        </Button>
      </div>
    </section>
  );
}
