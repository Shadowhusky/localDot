import { clsx } from "clsx";
import type { ReactNode } from "react";
import { Icon } from "./Icon.tsx";
import type { IconName } from "./icons.ts";

export interface EmptyStateProps {
  title: ReactNode;
  // What will appear here, or how to make it appear.
  children?: ReactNode;
  icon?: IconName;
  actions?: ReactNode;
  // Centred in the room a list would fill, or a quiet line where the list starts.
  layout?: "center" | "start";
  className?: string;
}

// What a list or panel shows once it has loaded and holds nothing yet. While it loads, a Skeleton.
export function EmptyState({
  title,
  children,
  icon,
  actions,
  layout = "center",
  className,
}: EmptyStateProps) {
  return (
    <div className={clsx("ui-empty", className)} data-layout={layout}>
      {icon && (
        <span className="ui-empty-art" aria-hidden="true">
          <Icon name={icon} size={layout === "center" ? 20 : 16} />
        </span>
      )}
      <p className="ui-empty-title">{title}</p>
      {children && <div className="ui-empty-detail">{children}</div>}
      {actions && <div className="ui-empty-actions">{actions}</div>}
    </div>
  );
}
