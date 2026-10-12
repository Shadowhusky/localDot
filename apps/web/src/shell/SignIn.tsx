import { useEffect, useState } from "react";
import { Dot } from "../dot/Dot.tsx";
import { HomeScreenSignIn } from "../notify/HomeScreenSignIn.tsx";
import { isHomeScreenApp } from "../notify/this-device.ts";
import { CommandChip } from "./CommandChip.tsx";
import "./sign-in.css";

export type SignInState = "first" | "checking" | "expired" | "signed-out" | "unconfirmed";

// A sign-in that finishes sooner than this shows nothing at all, so a quick one never flashes.
export const CHECKING_REVEAL_MS = 600;

const COMMAND = "localdot open";

const MESSAGES: Record<Exclude<SignInState, "checking">, string> = {
  unconfirmed:
    "Sign-in could not be confirmed. Check that localDot is running and try a fresh link:",
  first: "This page needs a sign-in link. Run this to get one:",
  expired: "That link has expired or was already used. Run this for a fresh one:",
  "signed-out": "This browser was signed out. Run this to sign in again:",
};

const HOME_SCREEN =
  "Open localDot in the browser where you’re already signed in. Go to Settings › Notifications › Copy sign-in link, then paste it here.";

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
            <h1 className="sign-in-title">Signing you in…</h1>
          </div>
        )}
      </main>
    );
  }
  if (homeScreen)
    return (
      <main className="sign-in" data-state={state}>
        <div className="sign-in-body">
          <Dot size={56} state={state === "first" ? "idle" : "waiting"} />
          <h1 className="sign-in-title">Sign in this app</h1>
          <p className="sign-in-message">
            {state === "signed-out" ? `This app was signed out. ${HOME_SCREEN}` : HOME_SCREEN}
          </p>
          <HomeScreenSignIn key={state} rejected={state === "expired"} />
          <p className="sign-in-foot">Each link works once, for one minute.</p>
        </div>
      </main>
    );
  const remote = window.location.hostname.includes("--dot.");
  return (
    <main className="sign-in" data-state={state}>
      <div className="sign-in-body">
        <Dot size={56} state={state === "first" ? "idle" : "waiting"} />
        <h1 className="sign-in-title">
          {remote ? "Sign in to localDot" : "Open localDot from Terminal"}
        </h1>
        <p className="sign-in-message" role={state === "first" ? "status" : "alert"}>
          {remote
            ? `${MESSAGES[state].split(". ")[0]}. On the computer running localDot, open Settings → Your computer → Remote access and create a new sign-in link.`
            : MESSAGES[state]}
        </p>
        {!remote && <CommandChip text={COMMAND} size="lg" className="sign-in-command" />}
        <p className="sign-in-foot">Each link works once, for one minute.</p>
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
