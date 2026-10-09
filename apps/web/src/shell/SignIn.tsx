import { useEffect, useState } from "react";
import { Dot } from "../dot/Dot.tsx";
import { CommandChip } from "./CommandChip.tsx";
import "./sign-in.css";

export type SignInState = "first" | "checking" | "expired" | "signed-out";

// A sign-in that finishes sooner than this shows nothing at all, so a quick one never flashes.
export const CHECKING_REVEAL_MS = 600;

const COMMAND = "localdot open";

const MESSAGES: Record<Exclude<SignInState, "checking">, string> = {
  first: "This page needs a sign-in link. Run this to get one:",
  expired: "That link has expired or was already used. Run this for a fresh one:",
  "signed-out": "This browser was signed out. Run this to sign in again:",
};

export function SignIn({ state }: { state: SignInState }) {
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
  return (
    <main className="sign-in" data-state={state}>
      <div className="sign-in-body">
        <Dot size={56} state={state === "first" ? "idle" : "waiting"} />
        <h1 className="sign-in-title">Open localDot from Terminal</h1>
        <p className="sign-in-message" role={state === "first" ? "status" : "alert"}>
          {MESSAGES[state]}
        </p>
        <CommandChip text={COMMAND} size="lg" className="sign-in-command" />
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
