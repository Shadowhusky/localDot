import { clsx } from "clsx";
import { useEffect } from "react";
import { copyBlocked, useCopy } from "../agent/useCopy.ts";
import { t } from "../i18n/index.ts";
import { announce } from "../ui/Announcer.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import "./sign-in.css";

// A command to run in Terminal: selectable on its plate, and copied with one press beside it.
export function CommandChip({
  text,
  size = "md",
  className,
}: {
  text: string;
  size?: "md" | "lg";
  className?: string;
}) {
  const { state, copy } = useCopy();
  useEffect(() => {
    if (state === "copied") announce("copy", t`Copied`);
  }, [state]);
  return (
    <div className={clsx("command-chip", className)} data-size={size}>
      <code>{text}</code>
      <IconButton
        icon={state === "copied" ? "check" : "copy"}
        label={state === "copied" ? t`Copied` : state === "failed" ? t`Couldn't copy` : t`Copy`}
        disabledReason={copyBlocked(text)}
        onClick={() => copy(text)}
      />
    </div>
  );
}
