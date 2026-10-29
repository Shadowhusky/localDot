import type { DotSummary } from "@localdot/protocol";
import { type RefObject, useRef } from "react";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";

// Stopping another dot ends what it is doing, so it asks first.
export function StopDotDialog({
  dot,
  anchor,
  onClose,
  onStop,
}: {
  dot: DotSummary | null;
  anchor?: RefObject<HTMLElement | null>;
  onClose(): void;
  onStop(dot: DotSummary): void;
}) {
  // Keeps the name while the dialog closes.
  const shown = useRef(dot);
  if (dot) shown.current = dot;
  return (
    <Dialog
      open={!!dot}
      onClose={onClose}
      anchor={anchor}
      title={`Stop ${shown.current?.name ?? "this dot"}?`}
      description="Its tasks stop and its computer shuts down. Its files, keys and sign-ins are kept, and you can start it again here."
    >
      <Button variant="quiet" onClick={onClose}>
        Cancel
      </Button>
      <Button
        variant="destructive"
        onClick={() => {
          if (shown.current) onStop(shown.current);
        }}
      >
        Stop
      </Button>
    </Dialog>
  );
}
