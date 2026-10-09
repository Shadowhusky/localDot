import { clsx } from "clsx";
import { createElement, type SVGProps } from "react";
import { ICONS, type IconName, type IconNode } from "./icons.ts";

const GRID = 24;
// In grid units, so the line thins a little as the icon shrinks, like the system's symbols.
const STROKE = 1.6;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  size?: 12 | 14 | 16 | 18 | 20 | 22;
  label?: string;
}

export function Icon({ name, size = 16, label, className, ...props }: IconProps) {
  const nodes: IconNode = ICONS[name];
  return (
    <svg
      viewBox={`0 0 ${GRID} ${GRID}`}
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      {...props}
      className={clsx("ui-icon", className)}
    >
      {nodes.map(([tag, attributes]) =>
        createElement(tag, { key: `${tag} ${Object.values(attributes).join(" ")}`, ...attributes }),
      )}
    </svg>
  );
}
