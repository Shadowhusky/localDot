import { clsx } from "clsx";
import type { ComponentProps } from "react";

export function VisuallyHidden({ className, ...props }: ComponentProps<"span">) {
  return <span {...props} className={clsx("ui-visually-hidden", className)} />;
}
