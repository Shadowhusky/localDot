import type { PersonaId } from "@localdot/protocol";
import type { RefObject } from "react";
import { PersonaPicker } from "../onboarding/PersonaPicker.tsx";
import { AutoDot, dotChoiceNote } from "../settings/AutoDot.tsx";
import { PHONE, useMediaQuery } from "../ui/media.ts";
import { Popover } from "../ui/Popover.tsx";
import { Sheet } from "../ui/Sheet.tsx";

// Which dot works with you, changed from dot itself: a press on it in the band opens this, over the
// stage on a wide screen and as a sheet on a phone. A choice is saved at once, as Settings → Your dot
// saves it.
export function DotChooser({
  open,
  anchor,
  value,
  onChange,
  auto,
  onClose,
}: {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  value: PersonaId;
  onChange(value: PersonaId): void;
  auto: { on: boolean; onChange(on: boolean): void; disabledReason?: string };
  onClose(): void;
}) {
  const phone = useMediaQuery(PHONE);
  const choices = (
    <>
      <AutoDot {...auto} />
      <PersonaPicker layout="rows" value={value} onChange={onChange} />
      <p className="persona-note">{dotChoiceNote(auto.on && !auto.disabledReason)}</p>
    </>
  );
  if (phone)
    return (
      <Sheet open={open} onClose={onClose} title="Your dot" side="bottom" doneLabel="Done">
        {choices}
      </Sheet>
    );
  return (
    <Popover
      open={open}
      onClose={onClose}
      anchor={anchor}
      side="top"
      align="start"
      title="Your dot"
    >
      {choices}
    </Popover>
  );
}
