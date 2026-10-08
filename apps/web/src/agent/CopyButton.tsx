import { useEffect, useRef } from "react";
import { IconButton } from "../ui/IconButton.tsx";
import { copyBlocked, useCopy } from "./useCopy.ts";

export function CopyButton({
  text,
  label,
  className,
  announce,
}: {
  text: string;
  label: string;
  className?: string;
  announce?(text: string): void;
}) {
  const { state, copy } = useCopy();
  const used = useRef(false);
  if (state !== "idle") used.current = true;
  useEffect(() => {
    if (state === "copied") announce?.("Copied.");
    else if (state === "failed") announce?.("Couldn't copy.");
  }, [state, announce]);
  return (
    <IconButton
      size={24}
      className={className}
      data-copy={state !== "idle" ? state : used.current ? "back" : undefined}
      icon={state === "copied" ? "check" : state === "failed" ? "x" : "copy"}
      label={state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy" : label}
      disabledReason={copyBlocked(text)}
      onClick={() => copy(text)}
    />
  );
}
