import { clsx } from "clsx";
import type { ReactNode } from "react";
import { VisuallyHidden } from "./VisuallyHidden.tsx";

const MOST = 99;

type Tone = "neutral" | "attention" | "danger";

export type BadgeProps = { tone?: Tone; className?: string } & (
  | { kind: "dot"; label: string }
  | { kind: "count"; children: number; label?: string }
  | { kind?: "label"; children: ReactNode }
);

export function Badge(props: BadgeProps) {
  const { tone = "neutral", className } = props;
  const shared = { "data-tone": tone, className: clsx("ui-badge", className) };
  if (props.kind === "dot") {
    return <span {...shared} data-kind="dot" role="img" aria-label={props.label} />;
  }
  if (props.kind === "count") {
    const count = props.children > MOST ? `${MOST}+` : String(props.children);
    return (
      <span {...shared} data-kind="count">
        {props.label ? (
          <>
            <span aria-hidden="true">{count}</span>
            <VisuallyHidden>{props.label}</VisuallyHidden>
          </>
        ) : (
          count
        )}
      </span>
    );
  }
  return (
    <span {...shared} data-kind="label">
      {props.children}
    </span>
  );
}
