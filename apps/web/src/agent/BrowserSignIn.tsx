import { useCallback, useEffect, useRef, useState } from "react";
import {
  UserBrowserSignInReply,
  UserBrowserSignInRequest,
} from "../../../../packages/protocol/src/browser-sign-in.ts";
import type { ApiClient } from "../lib/api.ts";
import { Button } from "../ui/Button.tsx";
import { controlRequest } from "./control-api.ts";

// Mounted only for the user's live browser hold. No password, page URL or cookie
// enters this component. Reopening it reads the real mode, not a local success flag.
export function BrowserSignIn({
  api,
  sessionId,
  requestId,
}: {
  api: ApiClient;
  sessionId: string;
  requestId: string;
}) {
  const [state, setState] = useState<ReturnType<typeof UserBrowserSignInReply.parse>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef<AbortController | null>(null);
  const call = useCallback(
    (action: "status" | "start", signal: AbortSignal) =>
      controlRequest(
        api,
        `/api/agent/sessions/${sessionId}/takeover/sign-in`,
        UserBrowserSignInRequest.parse({ requestId, action }),
        200,
        signal,
        (body) => UserBrowserSignInReply.parse(JSON.parse(body)),
      ),
    [api, sessionId, requestId],
  );
  useEffect(() => {
    const abort = new AbortController();
    alive.current = abort;
    setState(undefined);
    setBusy(false);
    setError("");
    void call("status", abort.signal).then(setState, () => {});
    return () => {
      abort.abort();
      alive.current = null;
    };
  }, [call]);
  const changing = state?.available === true && state.changing;
  useEffect(() => {
    if (!changing) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const poll = async () => {
      try {
        const actual = await call("status", abort.signal);
        if (abort.signal.aborted) return;
        setState(actual);
        if (!actual.available || !actual.changing) return;
      } catch {
        if (abort.signal.aborted) return;
      }
      if (++attempts < 30) timer = setTimeout(() => void poll(), 1000);
      else setError("Couldn't confirm sign-in mode. Check the browser before trying again.");
    };
    timer = setTimeout(() => void poll(), 500);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [changing, call]);
  const start = async () => {
    const signal = alive.current?.signal;
    if (!signal || signal.aborted || busy) return;
    setBusy(true);
    setError("");
    try {
      // A transition already in progress needs a status check, never another restart.
      setState(await call(changing ? "status" : "start", signal));
    } catch {
      if (!signal.aborted) {
        // A lost reply is not proof of failure. Inspect mode; never restart again automatically.
        try {
          const actual = await call("status", signal);
          setState(actual);
          if (actual.available && actual.mode === "signin" && !actual.changing) return;
        } catch {
          /* Leave the user in control. */
        }
        setError("Couldn't confirm sign-in mode. Check the browser before trying again.");
      }
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };
  if (state?.available === false) return null;
  const signingIn = state?.mode === "signin";
  return (
    <div className="thread-browser-signin">
      {changing ? (
        <p role="status">Switching browser mode…</p>
      ) : signingIn ? (
        <>
          <strong>Sign-in mode is on — you're in control</strong>
          <p role="status">
            Sign in now in the browser, then choose Hand back. dot can't see the page while you sign
            in, and stays signed in afterwards.
          </p>
        </>
      ) : (
        <>
          <strong>Sign in yourself</strong>
          <p>
            If a site won't accept sign-in while dot controls the browser, switch to a private
            browser only you control. Sign in, then choose Hand back — dot stays signed in
            afterwards and never sees your password or the page.
          </p>
          <Button variant="primary" busy={busy || state?.changing} onClick={() => void start()}>
            Sign in without agent control
          </Button>
          <p>Only the browser restarts; your tabs and saved sign-ins are kept.</p>
        </>
      )}
      {error && (
        <>
          <p role="alert">{error}</p>
          {changing && (
            <Button variant="secondary" size="sm" busy={busy} onClick={() => void start()}>
              Check status
            </Button>
          )}
        </>
      )}
    </div>
  );
}
