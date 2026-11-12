import { useEffect, useState } from "react";
import { Dot } from "../dot/Dot.tsx";
import { t, tr } from "../i18n/index.ts";
import { HomeScreenSignIn } from "../notify/HomeScreenSignIn.tsx";
import { isHomeScreenApp } from "../notify/this-device.ts";
import { CommandChip } from "./CommandChip.tsx";
import "./sign-in.css";

export type SignInState =
  | "first"
  | "checking"
  | "expired"
  | "signed-out"
  | "unconfirmed"
  // A shared link that stopped working while its guest was using it.
  | "ended";

// A sign-in that finishes sooner than this shows nothing at all, so a quick one never flashes.
export const CHECKING_REVEAL_MS = 600;

const COMMAND = "localdot open";

const MESSAGES: Record<Exclude<SignInState, "checking" | "ended">, string> = {
  unconfirmed: tr(
    "Sign-in could not be confirmed. Check that localDot is running and try a fresh link:",
  ),
  first: tr("This page needs a sign-in link. Run this to get one:"),
  expired: tr("That link has expired or was already used. Run this for a fresh one:"),
  "signed-out": tr("This browser was signed out. Run this to sign in again:"),
};

// The same, reached from another device, where the link comes from Remote access instead.
const REMOTE_MESSAGES: Record<Exclude<SignInState, "checking" | "ended">, string> = {
  unconfirmed: tr(
    "Sign-in could not be confirmed. On the computer running localDot, open Settings → Your computer → Remote access and create a new sign-in link.",
  ),
  first: tr(
    "This page needs a sign-in link. On the computer running localDot, open Settings → Your computer → Remote access and create a new sign-in link.",
  ),
  expired: tr(
    "That link has expired or was already used. On the computer running localDot, open Settings → Your computer → Remote access and create a new sign-in link.",
  ),
  "signed-out": tr(
    "This browser was signed out. On the computer running localDot, open Settings → Your computer → Remote access and create a new sign-in link.",
  ),
};

const HOME_SCREEN = tr(
  "Open localDot in the browser where you’re already signed in. Go to Settings › Notifications › Copy sign-in link, then paste it here.",
);

// homeScreen: opened from the Home Screen, which keeps its own storage and so signs in by itself.
export function SignIn({
  state,
  homeScreen = isHomeScreenApp(),
}: {
  state: SignInState;
  homeScreen?: boolean;
}) {
  const revealed = useRevealed(state === "checking" ? CHECKING_REVEAL_MS : 0);
  if (state === "checking") {
    return (
      <main className="sign-in" data-state={state}>
        {revealed && (
          <div className="sign-in-body" role="status">
            <Dot size={56} state="thinking" />
            <h1 className="sign-in-title">{t`Signing you in…`}</h1>
          </div>
        )}
      </main>
    );
  }
  if (state === "ended")
    return (
      <main className="sign-in" data-state={state}>
        <div className="sign-in-body">
          <Dot size={56} state="waiting" />
          <h1 className="sign-in-title">{t`This link has ended`}</h1>
          <p className="sign-in-message" role="alert">
            {t`It expired or the computer’s owner ended it. Ask them for a new link.`}
          </p>
        </div>
      </main>
    );
  if (homeScreen)
    return (
      <main className="sign-in" data-state={state}>
        <div className="sign-in-body">
          <Dot size={56} state={state === "first" ? "idle" : "waiting"} />
          <h1 className="sign-in-title">{t`Sign in this app`}</h1>
          <p className="sign-in-message">
            {state === "signed-out" ? t`This app was signed out. ${HOME_SCREEN}` : HOME_SCREEN}
          </p>
          <HomeScreenSignIn key={state} rejected={state === "expired"} />
          <p className="sign-in-foot">{t`Each link works once, for one minute.`}</p>
        </div>
      </main>
    );
  const remote = window.location.hostname.includes("--dot.");
  return (
    <main className="sign-in" data-state={state}>
      <div className="sign-in-body">
        <Dot size={56} state={state === "first" ? "idle" : "waiting"} />
        <h1 className="sign-in-title">
          {remote ? t`Sign in to localDot` : t`Open localDot from Terminal`}
        </h1>
        <p className="sign-in-message" role={state === "first" ? "status" : "alert"}>
          {remote ? REMOTE_MESSAGES[state] : MESSAGES[state]}
        </p>
        {!remote && <CommandChip text={COMMAND} size="lg" className="sign-in-command" />}
        <p className="sign-in-foot">{t`Each link works once, for one minute.`}</p>
      </div>
    </main>
  );
}

function useRevealed(delayMs: number): boolean {
  const [revealed, setRevealed] = useState(delayMs === 0);
  useEffect(() => {
    if (delayMs === 0) return;
    setRevealed(false);
    const timer = setTimeout(() => setRevealed(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);
  return revealed || delayMs === 0;
}
