import { useCallback, useEffect, useRef, useState } from "react";
import {
  type UserBrowserFill,
  UserBrowserSignInReply,
  UserBrowserSignInRequest,
} from "../../../../packages/protocol/src/browser-sign-in.ts";
import type { ApiClient } from "../lib/api.ts";
import { Button } from "../ui/Button.tsx";
import { controlRequest } from "./control-api.ts";

const OWN_BROWSER_LINE =
  "Google blocks browsers under agent control, so this one has dot's control turned off while you sign in.";
const SIGN_IN_MODE_LIMITS =
  "Saved logins can't be filled here, because nothing but you is connected to the page. Type yours or paste it.";
const PASSKEY_LINE =
  "Passkeys and security keys can't work in this browser: it has no Bluetooth, USB or device unlock. Choose the site's password or code option, such as “Try another way”.";

// How often the page the user holds is asked what it wants of them.
const PAGE_EVERY_MS = 3000;
// How long a page that took the account may take to ask for its password.
const PASSWORD_WAIT_TRIES = 4;

const FILL_LINES: Partial<Record<UserBrowserFill, string>> = {
  filled: "Your saved login is in. Check the page, then choose Sign in there.",
  "no-field":
    "There's no sign-in box showing on this page yet. Open the sign-in form, then try again.",
  form: "This page's form couldn't be verified, so nothing was filled. Type it here instead.",
  locked: "Saved logins are locked. Unlock them in Keys, then try again.",
  refused: "Nothing was filled, because the page changed. Check it, then try again.",
};

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
    (action: "status" | "start" | "fill" | "fill-password", signal: AbortSignal) =>
      controlRequest(
        api,
        `/api/agent/sessions/${sessionId}/takeover/sign-in`,
        UserBrowserSignInRequest.parse({ requestId, action }),
        200,
        signal,
        (body) => UserBrowserSignInReply.parse(JSON.parse(body)),
        "POST",
        16 * 1024,
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
  // The page in front can change while the user holds it: to a saved login's site, or to a sign-in
  // that turns away a browser under agent control.
  const standing = state?.available === true && state.mode === "standard" && !state.changing;
  useEffect(() => {
    if (!standing) return;
    const abort = new AbortController();
    const timer = setInterval(() => {
      if (document.hidden) return;
      void call("status", abort.signal).then(
        (actual) => {
          if (!abort.signal.aborted) setState(actual);
        },
        () => {},
      );
    }, PAGE_EVERY_MS);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [standing, call]);
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
  // A sign-in that can only work without agent control goes straight there, once for this hold.
  const ownBrowser = standing && state?.available === true && state.page?.ownBrowser === true;
  const startRef = useRef(start);
  startRef.current = start;
  const defaulted = useRef(false);
  useEffect(() => {
    if (!ownBrowser || defaulted.current) return;
    defaulted.current = true;
    void startRef.current();
  }, [ownBrowser]);
  const [filling, setFilling] = useState(false);
  const [fillLine, setFillLine] = useState("");
  const fill = async () => {
    const signal = alive.current?.signal;
    if (!signal || signal.aborted || filling) return;
    setFilling(true);
    setFillLine("");
    try {
      let reply = await call("fill", signal);
      setState(reply);
      // A page that took the account shows its password box next; the same tap covers both.
      if (reply.available && reply.fill === "account") {
        for (let tries = 0; tries < PASSWORD_WAIT_TRIES; tries++) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          signal.throwIfAborted();
          reply = await call("fill-password", signal);
          setState(reply);
          if (!reply.available || reply.fill !== "no-field") break;
        }
      }
      const outcome = reply.available ? reply.fill : undefined;
      setFillLine((outcome && FILL_LINES[outcome]) ?? "");
    } catch {
      if (!signal.aborted)
        setFillLine("Couldn't confirm the fill. Check the page before trying again.");
    } finally {
      if (!signal.aborted) setFilling(false);
    }
  };
  if (state?.available === false) return null;
  const signingIn = state?.mode === "signin";
  const saved = state?.available === true ? state.page?.saved : undefined;
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
          {defaulted.current && <p>{OWN_BROWSER_LINE}</p>}
          <p>{SIGN_IN_MODE_LIMITS}</p>
        </>
      ) : ownBrowser && !error ? (
        <p role="status">{OWN_BROWSER_LINE}</p>
      ) : (
        <>
          {saved && (
            <div className="thread-browser-signin-saved">
              <strong>Your saved login for {saved.site}</strong>
              <Button variant="primary" busy={filling} onClick={() => void fill()}>
                {saved.username ? `Sign in as ${saved.username}` : "Fill saved password"}
              </Button>
              <p>localDot enters it on this site without sharing it with dot.</p>
            </div>
          )}
          {fillLine && <p role="status">{fillLine}</p>}
          <strong>Sign in yourself</strong>
          <p>
            If a site won't accept sign-in while dot controls the browser, switch to a browser that
            only you control — same tabs and sign-ins, with dot's automation disconnected. Sign in,
            then choose Hand back; dot stays signed in afterwards and never sees your password.
          </p>
          <Button
            variant={saved ? "secondary" : "primary"}
            busy={busy || state?.changing}
            onClick={() => void start()}
          >
            Sign in without agent control
          </Button>
          <p>Only the browser restarts; your tabs and saved sign-ins are kept.</p>
          <p>{PASSKEY_LINE}</p>
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
