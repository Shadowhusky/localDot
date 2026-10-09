import type { Ref } from "react";
import { Button } from "../ui/Button.tsx";
import { triggerProps } from "../ui/Popover.tsx";
import { Progress } from "../ui/Progress.tsx";
import { type ExportJob, useExportJob } from "./job.ts";

// Export in the transport. While a video is made with its popover put away, a ring takes the icon's
// place and fills as it goes, then holds a check until the popover is opened again.
export function ExportButton({
  ref,
  job,
  open,
  disabledReason,
  onOpen,
}: {
  ref: Ref<HTMLButtonElement>;
  job: ExportJob;
  open: boolean;
  disabledReason?: string;
  onOpen(): void;
}) {
  const { phase, done, total } = useExportJob(job);
  const ring = !open && phase !== "options";
  const finished = phase === "ready" || phase === "downloaded" || phase === "saved";
  return (
    <Button
      ref={ref}
      className="replay-export"
      variant="quiet"
      icon="share"
      aria-label="Export video"
      data-ring={ring ? "" : undefined}
      {...triggerProps("dialog", open)}
      disabledReason={phase === "options" ? disabledReason : undefined}
      onClick={onOpen}
    >
      <span className="replay-export-ring">
        <Progress
          variant="ring"
          size={16}
          label="Exporting"
          value={
            finished
              ? 1
              : phase === "options"
                ? 0
                : phase === "exporting" && total
                  ? done
                  : undefined
          }
          max={finished ? 1 : total || 1}
        />
      </span>
      <span className="replay-export-text">Export</span>
    </Button>
  );
}
