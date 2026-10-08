import type { ReactNode } from "react";
import { Caption } from "./Caption.tsx";

export interface StageColumnProps {
  live: boolean;
  frozen: boolean;
  control: boolean;
  caption: string;
  children?: ReactNode;
  after?: ReactNode;
}

export function StageColumn({ live, frozen, control, caption, children, after }: StageColumnProps) {
  const classes = ["stage", live ? "lit" : "", frozen ? "frozen" : "", control ? "control" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <main className={after ? "stage-col manual-column" : "stage-col"}>
      <div className={classes}>{children}</div>
      <Caption text={caption} />
      {after}
    </main>
  );
}
