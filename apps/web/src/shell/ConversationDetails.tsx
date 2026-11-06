import { CONVERSATION_NAME_CHARS, type Wearable } from "@localdot/protocol";
import { useState } from "react";
import { DotAvatar } from "../dot/DotAvatar.tsx";
import { Button } from "../ui/Button.tsx";
import type { IconName } from "../ui/icons.ts";
import { Sheet } from "../ui/Sheet.tsx";
import { TextField } from "../ui/TextField.tsx";

export interface DetailRow {
  label: string;
  icon: IconName;
  note?: string;
  disabledReason?: string;
  run(): void;
}

// A conversation's name opened out: its dot, how it stands, and where to go from here.
export function ConversationDetails({
  open,
  onClose,
  title,
  status,
  look,
  seed,
  rows,
  onRename,
}: {
  open: boolean;
  onClose(): void;
  title: string;
  status: string;
  look: readonly Wearable[];
  seed: string;
  rows: readonly DetailRow[];
  // No conversation to name yet, without this.
  onRename?(name: string): void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const finish = () => {
    if (renaming !== null && renaming.trim() !== title) onRename?.(renaming.trim());
    setRenaming(null);
  };
  return (
    <Sheet
      open={open}
      onClose={() => {
        finish();
        onClose();
      }}
      title="Details"
      side="bottom"
      doneLabel="Done"
    >
      <div className="phone-details">
        <div className="phone-details-hero">
          <DotAvatar size={96} wearables={look} seed={seed} />
          {renaming === null ? (
            <strong>{title}</strong>
          ) : (
            <TextField
              aria-label="New name"
              placeholder="Automatic name"
              maxLength={CONVERSATION_NAME_CHARS}
              autoComplete="off"
              enterKeyHint="done"
              autoFocus
              value={renaming}
              onChange={(event) => setRenaming(event.target.value)}
              onBlur={finish}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  finish();
                }
              }}
            />
          )}
          <small className="num">{status}</small>
        </div>
        {onRename && (
          <Button
            variant="quiet"
            icon="type"
            className="phone-details-row"
            onClick={() => setRenaming(title)}
          >
            Rename
          </Button>
        )}
        {rows.map((row) => (
          <Button
            key={row.label}
            variant="quiet"
            icon={row.icon}
            className="phone-details-row"
            disabledReason={row.disabledReason}
            onClick={() => {
              onClose();
              row.run();
            }}
          >
            {row.label}
            {row.note && <small>{row.note}</small>}
          </Button>
        ))}
      </div>
    </Sheet>
  );
}
