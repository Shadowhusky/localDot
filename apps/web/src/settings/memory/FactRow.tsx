import { keyLikePresent, type MemoryEntry } from "@localdot/protocol";
import { useRef, useState } from "react";
import { Button } from "../../ui/Button.tsx";
import { IconButton } from "../../ui/IconButton.tsx";
import { Menu, MenuItem } from "../../ui/Menu.tsx";
import { triggerProps } from "../../ui/Popover.tsx";
import { TextArea } from "../../ui/TextArea.tsx";
import { MemoryRequestError } from "./memory-api.ts";
import { sourceLine } from "./memory-copy.ts";

export const KEY_SHAPED = "That looks like a key. Add it in Keys instead.";

export function factProblem(text: string): string | undefined {
  if (!text.trim()) return "Write the fact first.";
  if (text.length > 1000) return "Keep a fact under 1,000 characters.";
  if (text.includes("<!--") || text.includes("-->")) return "Leave out <!-- and -->.";
  if (keyLikePresent(text)) return KEY_SHAPED;
  return undefined;
}

// One fact: its words, where it came from, and pin, edit and delete. Editing happens in place;
// Escape ends the edit and nothing else.
export function FactRow({
  entry,
  onOpenTask,
  onSave,
  onTogglePin,
  onDelete,
}: {
  entry: MemoryEntry;
  onOpenTask?(sessionId: string): void;
  onSave(text: string): Promise<unknown>;
  onTogglePin(): void;
  onDelete(): void;
}) {
  const more = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const source = sourceLine(entry);
  const begin = () => {
    setDraft(entry.text);
    setNote(null);
  };
  const end = () => {
    setDraft(null);
    setNote(null);
  };
  const save = async () => {
    if (draft === null || busy) return;
    const problem = factProblem(draft);
    if (problem) {
      setNote(problem);
      return;
    }
    if (draft === entry.text) {
      end();
      return;
    }
    setBusy(true);
    try {
      await onSave(draft);
      end();
    } catch (error) {
      setNote(
        error instanceof MemoryRequestError && error.reason === "stale"
          ? "This fact changed while you were editing. Your text is kept; save again."
          : error instanceof MemoryRequestError && error.reason === "busy"
            ? "Memory can't change while you have control of the computer."
            : "Couldn't reach localDot. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  if (draft !== null)
    return (
      <li className="ui-group-row memory-row" data-editing="">
        <form
          className="memory-edit"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <TextArea
            aria-label="Fact"
            value={draft}
            maxRows={8}
            autoFocus
            onChange={(event) => {
              setDraft(event.target.value);
              setNote(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void save();
              } else if (event.key === "Escape") {
                event.preventDefault();
                end();
              }
            }}
          />
          {note && (
            <p className="memory-note" role="alert">
              {note}
            </p>
          )}
          <div className="memory-edit-actions">
            <Button variant="quiet" size="sm" onClick={end}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" busy={busy}>
              Save
            </Button>
          </div>
        </form>
      </li>
    );
  return (
    <li className="ui-group-row memory-row">
      <div className="ui-group-row-line">
        <span className="ui-group-row-text">
          <span className="memory-fact">{entry.text}</span>
          <span className="ui-group-row-detail">
            {source.sessionId && onOpenTask ? (
              <button
                type="button"
                className="memory-source"
                onClick={() => onOpenTask(source.sessionId as string)}
              >
                {source.text}
              </button>
            ) : (
              source.text
            )}
          </span>
        </span>
        <span className="ui-group-row-trailing memory-actions">
          <IconButton
            icon="pin"
            label={entry.pinned ? "Stop always remembering" : "Always remember"}
            aria-pressed={entry.pinned}
            data-on={entry.pinned ? "" : undefined}
            className="memory-pin"
            onClick={onTogglePin}
          />
          <IconButton
            ref={more}
            icon="more-horizontal"
            label="More for this fact"
            {...triggerProps("menu", menu)}
            onClick={() => setMenu(true)}
          />
        </span>
      </div>
      <Menu open={menu} onClose={() => setMenu(false)} anchor={more} align="end" label="Fact">
        <MenuItem onSelect={begin}>Edit</MenuItem>
        <MenuItem onSelect={onDelete}>Delete</MenuItem>
      </Menu>
    </li>
  );
}
