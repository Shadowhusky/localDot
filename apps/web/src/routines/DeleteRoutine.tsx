import type { Routine } from "@localdot/protocol";
import type { RefObject } from "react";
import { t } from "../i18n/index.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";

// Deleting a routine takes its schedule and history; its runs' recordings stay in Replay.
export function DeleteRoutine({
  routine,
  anchor,
  busy,
  onClose,
  onDelete,
}: {
  routine: Routine | null;
  anchor: RefObject<HTMLElement | null>;
  busy: boolean;
  onClose(): void;
  onDelete(routine: Routine): void;
}) {
  return (
    <Dialog
      open={routine !== null}
      onClose={() => {
        if (!busy) onClose();
      }}
      anchor={anchor}
      title={routine ? t`Delete ${routine.name}?` : t`Delete this routine?`}
      description={t`It stops running and its run history goes. Recordings of its runs stay in Replay.`}
    >
      <Button variant="quiet" disabledReason={busy ? t`Deleting…` : undefined} onClick={onClose}>
        {t`Cancel`}
      </Button>
      <Button variant="destructive" busy={busy} onClick={() => routine && onDelete(routine)}>
        {t`Delete`}
      </Button>
    </Dialog>
  );
}
