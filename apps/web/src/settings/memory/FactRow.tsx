import { keyLikePresent, type MemoryEntry } from "@localdot/protocol";
import { type ReactNode, useRef, useState } from "react";
import { t } from "../../i18n/index.ts";
import { Button } from "../../ui/Button.tsx";
import { IconButton } from "../../ui/IconButton.tsx";
import { Menu, MenuItem } from "../../ui/Menu.tsx";
import { triggerProps } from "../../ui/Popover.tsx";
import { useRevealInvalid } from "../../ui/reveal-field.ts";
import { TextArea } from "../../ui/TextArea.tsx";
import { MemoryRequestError } from "./memory-api.ts";
import { sourceLine } from "./memory-copy.ts";

export const KEY_SHAPED = t`That looks like a key. Add it in Keys instead.`;

export function factProblem(text: string): string | undefined {
  if (!text.trim()) return t`Write the fact first.`;
  if (text.length > 1000) return t`Keep a fact under 1,000 characters.`;
  if (text.includes("<!--") || text.includes("-->")) return t`Leave out <!-- and -->.`;
  if (keyLikePresent(text)) return KEY_SHAPED;
  return undefined;
}

// Where something dot knows came from: a quiet link to the task that taught it, or plain words. A
// long task title shortens; the day after it stays.
export function SourceLink({
  text,
  day = "",
  sessionId,
  onOpenTask,
}: {
  text: string;
  day?: string;
  sessionId?: string;
  onOpenTask?(sessionId: string): void;
}) {
  if (!sessionId || !onOpenTask) return `${text}${day}`;
  return (
    <span className="memory-source-line">
      <Button
        variant="quiet"
        size="sm"
        className="memory-source shrink"
        onClick={() => onOpenTask(sessionId)}
      >
        <span className="memory-source-text">{text}</span>
      </Button>
      {day && <span className="memory-source-day">{day}</span>}
    </span>
  );
}

// One fact or daily note: its words, where it came from, and pin (facts only), edit and delete.
// Editing happens in place; Escape ends the edit and nothing else.
export function FactRow({
  entry,
  noun = "Fact",
  heading,
  onOpenTask,
  onSave,
  onTogglePin,
  onDelete,
}: {
  entry: MemoryEntry;
  noun?: "Fact" | "Note";
  // A label over this row that names the rows from here on.
  heading?: ReactNode;
  onOpenTask?(sessionId: string): void;
  onSave(text: string): Promise<unknown>;
  onTogglePin?(): void;
  onDelete(): void;
}) {
  const more = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { scope, reveal } = useRevealInvalid<HTMLFormElement>();
  const source = sourceLine(entry);
  const name = noun === "Note" ? t`Note` : t`Fact`;
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
      reveal();
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
          ? noun === "Note"
            ? t`This note changed while you were editing. Your text is kept; save again.`
            : t`This fact changed while you were editing. Your text is kept; save again.`
          : error instanceof MemoryRequestError && error.reason === "busy"
            ? t`Memory can't change while you have control of the computer.`
            : t`Couldn't reach localDot. Try again.`,
      );
    } finally {
      setBusy(false);
    }
  };
  if (draft !== null)
    return (
      <li className="ui-group-row memory-row" data-editing="">
        {heading}
        <form
          ref={scope}
          className="memory-edit"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <TextArea
            aria-label={name}
            aria-invalid={note ? true : undefined}
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
              {t`Cancel`}
            </Button>
            <Button type="submit" variant="primary" size="sm" busy={busy}>
              {t`Save`}
            </Button>
          </div>
        </form>
      </li>
    );
  return (
    <li className="ui-group-row memory-row">
      {heading}
      <div className="ui-group-row-line">
        <span className="ui-group-row-text">
          <span className="memory-fact">{entry.text}</span>
          <span className="ui-group-row-detail">
            <SourceLink {...source} onOpenTask={onOpenTask} />
          </span>
        </span>
        <span className="ui-group-row-trailing memory-actions pointer-coarse:gap-4">
          {onTogglePin && (
            <IconButton
              icon="pin"
              label={entry.pinned ? t`Stop always remembering` : t`Always remember`}
              aria-pressed={entry.pinned}
              data-on={entry.pinned ? "" : undefined}
              className="memory-pin"
              onClick={onTogglePin}
            />
          )}
          <IconButton
            ref={more}
            icon="more-horizontal"
            label={noun === "Note" ? t`More for this note` : t`More for this fact`}
            {...triggerProps("menu", menu)}
            onClick={() => setMenu(true)}
          />
        </span>
      </div>
      <Menu open={menu} onClose={() => setMenu(false)} anchor={more} align="end" label={name}>
        <MenuItem onSelect={begin}>{t`Edit`}</MenuItem>
        <MenuItem onSelect={onDelete}>{t`Delete`}</MenuItem>
      </Menu>
    </li>
  );
}
