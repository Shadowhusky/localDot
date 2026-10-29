import type { DeleteSessionsResult, SessionCard } from "@localdot/protocol";
import { type RefObject, useEffect, useRef, useState } from "react";
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
  deleteProblem,
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
  onDeleted,
}: {
  api: ApiClient;
  // What it deletes; null while closed.
  cards: readonly SessionCard[] | null;
  // The Free up space choice that picked them.
  cleanup?: Cleanup;
  anchor: RefObject<HTMLElement | null>;
  onClose(): void;
  onDeleted(result: DeleteSessionsResult): void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const open = cards !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each opening starts clean.
  useEffect(() => {
    setProblem(null);
    setBusy(false);
  }, [open]);
  const n = cards?.length ?? 0;
  const remove = async () => {
    if (!cards || busy || n === 0) return;
    setBusy(true);
    setProblem(null);
    const result = await deleteRecordings(
      api,
      cards.map((card) => card.id),
    );
    setBusy(false);
    onDeleted(result);
    if (result.live.length > 0 || result.failed.length > 0) setProblem(deleteProblem(result));
    else onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      anchor={anchor}
      title={cleanup && !problem ? cleanup.title(n) : deleteTitle(n)}
      description={problem ? <span role="alert">{problem}</span> : deleteBody(n)}
      facts={n > 0 ? [["Frees", bytes(totalBytes(cards ?? []))]] : undefined}
    >
      <Button
        variant="quiet"
        disabledReason={busy ? "Deleting the recordings…" : undefined}
        onClick={onClose}
      >
        Cancel
      </Button>
      <Button variant="destructive" busy={busy} onClick={() => void remove()}>
        Delete
      </Button>
    </Dialog>
  );
}
