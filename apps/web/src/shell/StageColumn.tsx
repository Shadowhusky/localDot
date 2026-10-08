import type { ReactNode } from "react";
import { Caption } from "./Caption.tsx";

export interface StageColumnProps {
  live: boolean;
  frozen: boolean;
  control: boolean;
  caption: string;
  children?: ReactNode;
  // A layer over the whole column rather than the stage alone.
  cover?: ReactNode;
  after?: ReactNode;
}

export function StageColumn({
  live,
  frozen,
  control,
  caption,
  children,
  cover,
  after,
}: StageColumnProps) {
  const classes = ["stage", live ? "lit" : "", frozen ? "frozen" : "", control ? "control" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <main className={after ? "stage-col manual-column" : "stage-col"}>
      {cover}
      <div className={classes}>{children}</div>
      <Caption text={caption} />
      {after}
    </main>
  );
}
