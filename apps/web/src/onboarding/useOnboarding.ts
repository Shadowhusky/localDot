import { useCallback, useState } from "react";
import {
  FRESH,
  ONBOARDING_KEY,
  parseProgress,
  type WizardProgress,
  type WizardStep,
  wizardShown,
} from "./wizard.ts";

function stored(): WizardProgress {
  try {
    return parseProgress(localStorage.getItem(ONBOARDING_KEY));
  } catch {
    return FRESH;
  }
}

function keep(progress: WizardProgress) {
  try {
    localStorage.setItem(ONBOARDING_KEY, JSON.stringify(progress));
  } catch {}
}

// First-run setup's place, kept in this browser after every change so a reload comes back to it.
// A page opened on a recording plays it first: setup waits until the live app opens.
export function useOnboarding({
  known,
  configured,
  replaying,
}: {
  known: boolean;
  configured: boolean;
  replaying: boolean;
}) {
  const [progress, setProgress] = useState(stored);
  const [waits, setWaits] = useState(replaying);
  if (waits && !replaying) setWaits(false);
  const update = useCallback((change: (now: WizardProgress) => WizardProgress) => {
    setProgress((now) => {
      const next = change(now);
      keep(next);
      return next;
    });
  }, []);
  return {
    progress,
    open: !waits && wizardShown({ known, configured, progress }),
    update,
    go: (step: WizardStep, back?: WizardProgress["back"]) =>
      update((now) => ({ ...now, step, back })),
    // Finish later: the rail keeps what is left until Continue setup.
    later: () => update((now) => ({ ...now, dismissed: true })),
    // Continue setup, or Settings' own way back in, which starts at the first choice.
    reopen: (from?: WizardStep) => {
      setWaits(false);
      update((now) => ({
        ...now,
        step: from ?? (now.finished || now.step === "welcome" ? "thinks" : now.step),
        dismissed: false,
        finished: false,
        back: undefined,
      }));
    },
    finish: () => update((now) => ({ ...now, step: "turn-on", finished: true, back: undefined })),
  };
}

export type OnboardingControl = ReturnType<typeof useOnboarding>;
