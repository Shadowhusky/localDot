import type { TagId } from "@localdot/protocol";
import { type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import type { TagInUse } from "../agent/conversation-list.ts";
import { t } from "../i18n/index.ts";
import { Button } from "../ui/Button.tsx";
import { TagDot, tagName } from "../ui/ConversationTag.tsx";
import { Collapse } from "../ui/Disclosure.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Marquee } from "../ui/Marquee.tsx";
import { matches } from "../ui/media.ts";
import { sidewaysWheel } from "../ui/sideways-wheel.ts";
import { TextField } from "../ui/TextField.tsx";
import "../ui/conversation-switcher.css";

const fold = (text: string) => text.trim().toLocaleLowerCase();

// Which ends of the strip have more tags past them, so each fades out where it does.
function useEdges() {
  const [edges, setEdges] = useState({ start: false, end: false });
  const read = useCallback((strip: HTMLElement) => {
    const room = strip.scrollWidth - strip.clientWidth;
    const start = strip.scrollLeft > 1;
    const end = strip.scrollLeft < room - 1;
    setEdges((was) => (was.start === start && was.end === end ? was : { start, end }));
  }, []);
  return [edges, read] as const;
}

// Above a list: one line of the tags its conversations carry, each a filter, that scrolls sideways
// under a pinned All. All unfolds the whole list in place, with a search, and what sorts the
// conversations into tags with the user's model.
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
  const [open, setOpen] = useState(false);
  const [edges, readEdges] = useEdges();
  const strip = useRef<HTMLDivElement | null>(null);
  const allButton = useRef<HTMLButtonElement>(null);
  const panel = useId();
  // The chosen tag comes into sight in the strip, however it was chosen.
  useEffect(() => {
    const row = strip.current;
    const chip =
      tagged &&
      [...(row?.querySelectorAll<HTMLElement>("[data-tag-id]") ?? [])].find(
        (each) => each.dataset.tagId === tagged,
      );
    if (!row || !chip) return;
    // The strip is the chips' offset parent.
    const left = chip.offsetLeft;
    const right = left + chip.offsetWidth;
    const pad = row.clientWidth * 0.1;
    const to =
      left < row.scrollLeft
        ? Math.max(0, left - pad)
        : right > row.scrollLeft + row.clientWidth
          ? right - row.clientWidth + pad
          : null;
    if (to === null) return;
    if (typeof row.scrollTo === "function") row.scrollTo({ left: to, behavior: "smooth" });
    else row.scrollLeft = to;
  }, [tagged]);
  const attach = useCallback(
    (element: HTMLDivElement | null) => {
      strip.current = element;
      if (!element) return;
      readEdges(element);
      const undoWheel = sidewaysWheel(element);
      const onScroll = () => readEdges(element);
      element.addEventListener("scroll", onScroll, { passive: true });
      const observer =
        typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => readEdges(element));
      observer?.observe(element);
      return () => {
        undoWheel?.();
        element.removeEventListener("scroll", onScroll);
        observer?.disconnect();
      };
    },
    [readEdges],
  );
  if (!tags.length && !onSort) return null;
  if (!tags.length && onSort)
    return (
      <div className="conversations-tags">
        <div className="conversations-tags-row">
          <Button
            variant="quiet"
            size="sm"
            icon="bot"
            className="conversations-tag conversations-sort"
            onClick={onSort}
          >
            {t`Sort into tags`}
          </Button>
        </div>
      </div>
    );
  const close = (focus = false) => {
    setOpen(false);
    if (focus) allButton.current?.focus();
  };
  return (
    <div className="conversations-tags" data-open={open || undefined}>
      <div className="conversations-tags-row">
        {/* biome-ignore lint/a11y/useSemanticElements: a row of toggles, not a form's fieldset. */}
        <div
          ref={attach}
          className="conversations-tags-strip"
          role="group"
          aria-label={t`Show only a tag`}
          data-more-start={edges.start || undefined}
          data-more-end={edges.end || undefined}
        >
          {tags.map((each) => (
            <Button
              key={each.id}
              variant="quiet"
              size="sm"
              className="conversations-tag"
              data-tag-id={each.id}
              aria-pressed={tagged === each.id}
              onClick={() => onTag(tagged === each.id ? null : each.id)}
            >
              <TagDot tag={each.color} />
              {tagName(each)}
            </Button>
          ))}
        </div>
        <Button
          ref={allButton}
          variant="quiet"
          size="sm"
          className="conversations-tag conversations-tags-all"
          aria-label={t`All tags · ${tags.length.toLocaleString()}`}
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen((was) => !was)}
        >
          {t`All`}
          <span className="conversations-tags-count num">{tags.length.toLocaleString()}</span>
          <Icon name="chevron-down" size={14} className="conversations-tags-chevron" />
        </Button>
      </div>
      <Collapse open={open} id={panel} fit className="conversations-tags-panel">
        <AllTags
          tags={tags}
          tagged={tagged}
          onClose={() => close(true)}
          onTag={(tag) => {
            close();
            onTag(tag);
          }}
          {...(onSort
            ? {
                onSort: () => {
                  close();
                  onSort();
                },
              }
            : {})}
        />
      </Collapse>
    </div>
  );
}

function AllTags({
  tags,
  tagged,
  onClose,
  onTag,
  onSort,
}: {
  tags: readonly TagInUse[];
  tagged: TagId | null;
  onClose(): void;
  onTag(tag: TagId | null): void;
  onSort?(): void;
}) {
  const [query, setQuery] = useState("");
  const found = tags.filter((tag) => fold(tagName(tag)).includes(fold(query)));
  const field = useRef<HTMLInputElement>(null);
  // A keyboard goes straight to the search; a finger isn't handed a keyboard it didn't ask for.
  useEffect(() => {
    if (matches("(pointer: fine)")) field.current?.focus({ preventScroll: true });
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };
  return (
    <section className="all-tags" aria-label={t`All tags`} onKeyDown={onKeyDown}>
      <TextField
        ref={field}
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
            <Marquee className="all-tags-name">{tagName(tag)}</Marquee>
            <span className="all-tags-count num">{tag.count.toLocaleString()}</span>
          </Button>
        ))}
        {!found.length && <p className="all-tags-note">{t`No tag is called that.`}</p>}
      </div>
      {onSort && (
        <Button variant="quiet" icon="bot" className="all-tags-row all-tags-sort" onClick={onSort}>
          {t`Sort into tags`}
        </Button>
      )}
    </section>
  );
}
