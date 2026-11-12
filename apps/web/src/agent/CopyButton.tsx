import { useEffect, useRef } from "react";
import { t } from "../i18n/index.ts";
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
    if (state === "copied") announce?.(t`Copied.`);
    else if (state === "failed") announce?.(t`Couldn't copy.`);
  }, [state, announce]);
  return (
    <IconButton
      size={24}
      className={className}
      data-copy={state !== "idle" ? state : used.current ? "back" : undefined}
      icon={state === "copied" ? "check" : state === "failed" ? "x" : "copy"}
      label={state === "copied" ? t`Copied` : state === "failed" ? t`Couldn't copy` : label}
      disabledReason={copyBlocked(text)}
      onClick={() => copy(text)}
    />
  );
}
