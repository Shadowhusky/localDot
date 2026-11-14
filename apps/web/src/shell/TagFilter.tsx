import type { TagId } from "@localdot/protocol";
import { type RefObject, useRef, useState } from "react";
import type { TagInUse } from "../agent/conversation-list.ts";
import { t } from "../i18n/index.ts";
import { Button } from "../ui/Button.tsx";
import { TagDot, tagName } from "../ui/ConversationTag.tsx";
import { PHONE, useMediaQuery } from "../ui/media.ts";
import { Popover } from "../ui/Popover.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import { TextField } from "../ui/TextField.tsx";
import "../ui/conversation-switcher.css";

// The most a row shows before the rest wait behind All tags.
const SHOWN = 8;

const fold = (text: string) => text.trim().toLocaleLowerCase();

// Above a list: the tags its conversations carry most, each showing only those with it, the rest a
// search away under All tags; and what sorts them into tags with the user's model. The row wraps,
// so every tag on it is in sight.
export function TagFilter({
  tags,
  tagged,
  onTag,
  onSort,
}: {
  tags: readonly TagInUse[];
  tagged: TagId | null;
  onTag(tag: TagId | null): void;
  onSort?(): void;
}) {
  const allButton = useRef<HTMLButtonElement>(null);
  const [all, setAll] = useState(false);
  if (!tags.length && !onSort) return null;
  const more = tags.length > SHOWN;
  const top = more ? tags.slice(0, SHOWN - 1) : tags;
  const chosen = tags.find((tag) => tag.id === tagged);
  const shown = chosen && !top.includes(chosen) ? [...top, chosen] : top;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a row of toggles, not a form's fieldset.
    <div className="conversations-tags" role="group" aria-label={t`Show only a tag`}>
      {shown.map((each) => (
        <Button
          key={each.id}
          variant="quiet"
          size="sm"
          className="conversations-tag"
          aria-pressed={tagged === each.id}
          onClick={() => onTag(tagged === each.id ? null : each.id)}
        >
          <TagDot tag={each.color} />
          {tagName(each)}
        </Button>
      ))}
      {more && (
        <Button
          ref={allButton}
          variant="quiet"
          size="sm"
          icon="tag"
          className="conversations-tag"
          aria-haspopup="dialog"
          aria-expanded={all}
          onClick={() => setAll(true)}
        >
          {t`All tags · ${tags.length.toLocaleString()}`}
        </Button>
      )}
      {onSort && (
        <Button
          variant="quiet"
          size="sm"
          icon="bot"
          className="conversations-tag conversations-sort"
          onClick={onSort}
        >
          {t`Sort into tags`}
        </Button>
      )}
      {more && (
        <AllTags
          open={all}
          anchor={allButton}
          tags={tags}
          tagged={tagged}
          onClose={() => setAll(false)}
          onTag={(tag) => {
            setAll(false);
            onTag(tag);
          }}
        />
      )}
    </div>
  );
}

function AllTags({
  open,
  anchor,
  tags,
  tagged,
  onClose,
  onTag,
}: {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  tags: readonly TagInUse[];
  tagged: TagId | null;
  onClose(): void;
  onTag(tag: TagId | null): void;
}) {
  const phone = useMediaQuery(PHONE);
  const [query, setQuery] = useState("");
  const found = tags.filter((tag) => fold(tagName(tag)).includes(fold(query)));
  const body = (
    <div className="all-tags">
      <TextField
        aria-label={t`Find a tag`}
        placeholder={t`Find a tag`}
        autoComplete="off"
        enterKeyHint="go"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          const only = found.length === 1 ? found[0] : undefined;
          if (event.key === "Enter" && !event.nativeEvent.isComposing && only) {
            event.preventDefault();
            onTag(only.id);
          }
        }}
      />
      <div className="all-tags-list">
        {tagged && (
          <Button variant="quiet" className="all-tags-row" onClick={() => onTag(null)}>
            {t`Every conversation`}
          </Button>
        )}
        {found.map((tag) => (
          <Button
            key={tag.id}
            variant="quiet"
            className="all-tags-row"
            aria-pressed={tag.id === tagged}
            onClick={() => onTag(tag.id)}
          >
            <TagDot tag={tag.color} />
            <span className="all-tags-name">{tagName(tag)}</span>
            <span className="all-tags-count num">{tag.count.toLocaleString()}</span>
          </Button>
        ))}
        {!found.length && <p className="all-tags-note">{t`No tag is called that.`}</p>}
      </div>
    </div>
  );
  if (phone)
    return (
      <Sheet open={open} onClose={onClose} title={t`All tags`} side="bottom" doneLabel={t`Done`}>
        {body}
      </Sheet>
    );
  return (
    <Popover
      open={open}
      onClose={onClose}
      anchor={anchor}
      side="bottom"
      align="start"
      title={t`All tags`}
    >
      {body}
    </Popover>
  );
}
