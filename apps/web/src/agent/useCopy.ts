import { keyLikePresent } from "@localdot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

export type CopyState = "idle" | "copied" | "failed";

// How long the copy button shows its check before it is a copy button again.
export const COPIED_MS = 1500;

export function copyBlocked(text: string): string | undefined {
  if (keyLikePresent(text)) return "This looks like it holds a key, so it can't be copied.";
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText)
    return "Copy isn't available in this browser.";
  return undefined;
}

export function useCopy() {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback((text: string) => {
    if (copyBlocked(text)) return;
    const settle = (next: CopyState) => {
      setState(next);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setState("idle"), COPIED_MS);
    };
    navigator.clipboard.writeText(text).then(
      () => settle("copied"),
      () => settle("failed"),
    );
  }, []);
  return { state, copy };
}
