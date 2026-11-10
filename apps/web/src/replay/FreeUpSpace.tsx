import type { DeleteSessionsResult, SessionCard } from "@localdot/protocol";
import { type RefObject, useRef, useState } from "react";
import { bytes } from "../copy/format.ts";
import type { ApiClient } from "../lib/api.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Menu, MenuItem } from "../ui/Menu.tsx";
import { triggerProps } from "../ui/Popover.tsx";
import {
  amount,
  CLEANUPS,
  type Cleanup,
  deleteBody,
  deleteRecordings,
  deleteTitle,
  totalBytes,
} from "./cleanup.ts";

// Free up space: each quick choice with what it would delete and free, counted over every page.
export function FreeUpSpace({
  cards,
  counting,
  onOpen,
  onChoose,
}: {
  cards: readonly SessionCard[];
  // Pages are still loading, so the counts would be short.
  counting: boolean;
  onOpen(): void;
  onChoose(cleanup: Cleanup, picks: SessionCard[]): void;
}) {
  // When the menu opened, which the ages are counted from; null while it is closed.
  const [openedAt, setOpenedAt] = useState<Date | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const open = openedAt !== null;
  return (
    <>
      <Button
        ref={anchor}
        variant="quiet"
        size="sm"
        {...triggerProps("menu", open)}
        onClick={() => {
          if (!open) onOpen();
          setOpenedAt(open ? null : new Date());
        }}
      >
        Free up space
        <Icon name="chevron-down" size={14} />
      </Button>
      <Menu
        open={open}
        onClose={() => setOpenedAt(null)}
        anchor={anchor}
        label="Free up space"
        align="end"
      >
        {CLEANUPS.map((cleanup) => {
          const picks = counting || !openedAt ? [] : cleanup.picks(cards, openedAt);
          return (
            <MenuItem
              key={cleanup.label}
              textValue={cleanup.label}
              disabledReason={
                counting ? "Counting recordings…" : picks.length === 0 ? cleanup.none : undefined
              }
              onSelect={() => onChoose(cleanup, picks)}
            >
              <span className="replay-cleanup">
                <span>{cleanup.label}</span>
                {picks.length > 0 && <span className="replay-cleanup-amount">{amount(picks)}</span>}
              </span>
            </MenuItem>
          );
        })}
      </Menu>
    </>
  );
}

// The confirmation for deleting several recordings. A running one, or one that couldn't go, stays
// chosen and the confirmation stays open to say so.
export function DeleteRecordings({
  api,
  cards,
  cleanup,
  anchor,
  onClose,
  onDeleting,
  onDeleted,
}: {
  api: ApiClient;
  // What it deletes; null while closed.
  cards: readonly SessionCard[] | null;
  // The Free up space choice that picked them.
  cleanup?: Cleanup;
  anchor: RefObject<HTMLElement | null>;
  onClose(): void;
  // As soon as they are confirmed: they leave the list while the daemon deletes them.
  onDeleting(ids: readonly string[]): void;
  // Once the daemon has answered; any it kept come back.
  onDeleted(result: DeleteSessionsResult): void;
}) {
  const n = cards?.length ?? 0;
  const remove = () => {
    if (!cards || n === 0) return;
    const ids = cards.map((card) => card.id);
    void deleteRecordings(api, ids).then(onDeleted);
    onDeleting(ids);
    onClose();
  };
  return (
    <Dialog
      open={cards !== null}
      onClose={onClose}
      anchor={anchor}
      title={cleanup ? cleanup.title(n) : deleteTitle(n)}
      description={deleteBody(n)}
      facts={n > 0 ? [["Frees", bytes(totalBytes(cards ?? []))]] : undefined}
    >
      <Button variant="quiet" onClick={onClose}>
        Cancel
      </Button>
      <Button variant="destructive" onClick={remove}>
        Delete
      </Button>
    </Dialog>
  );
}
