import {
  CONVERSATION_TAGS,
  type ConversationEntry,
  type ConversationTag,
  type NamedTag,
  TAG_NAME_CHARS,
  type TagId,
  TagName,
} from "@localdot/protocol";
import { type RefObject, useState } from "react";
import {
  changeTag,
  createTag,
  deleteTag,
  organizeConversation,
  toggledTag,
  useRecentConversations,
} from "../agent/conversation-list.ts";
import { t } from "../i18n/index.ts";
import type { ApiClient } from "../lib/api.ts";
import { Button } from "../ui/Button.tsx";
import { ColourChoice, TagDot, TagSwatches } from "../ui/ConversationTag.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { PHONE, useMediaQuery } from "../ui/media.ts";
import { Popover } from "../ui/Popover.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import { TextField } from "../ui/TextField.tsx";
import { showToast } from "../ui/Toast.tsx";
import "../ui/conversations-layout.css";

const fold = (name: string) => name.trim().toLocaleLowerCase();

// The colour a new tag takes: the one the user's tags use least.
function nextColour(library: readonly NamedTag[]): ConversationTag {
  const uses = (colour: ConversationTag) => library.filter((tag) => tag.color === colour).length;
  return [...CONVERSATION_TAGS].sort((a, b) => uses(a) - uses(b))[0] ?? "blue";
}

// A conversation's one tag: a colour, or one of the user's own, found or made by typing a name.
// Each choice is saved at once, as a colour is from the menu; a tag can be renamed, recoloured or
// deleted here too.
export function TagChooser({
  api,
  entry,
  anchor,
  onClose,
}: {
  api: ApiClient;
  // The conversation being tagged; open while there is one.
  entry: ConversationEntry | null;
  anchor: RefObject<HTMLElement | null>;
  onClose(): void;
}) {
  const phone = useMediaQuery(PHONE);
  const body = entry && <TagPanel key={entry.sessionId} api={api} entry={entry} />;
  if (phone)
    return (
      <Sheet open={!!entry} onClose={onClose} title={t`Tags`} side="bottom" doneLabel={t`Done`}>
        {body}
      </Sheet>
    );
  return (
    <Popover
      open={!!entry}
      onClose={onClose}
      anchor={anchor}
      side="right"
      align="start"
      title={t`Tags`}
    >
      {body}
    </Popover>
  );
}

function TagPanel({ api, entry }: { api: ApiClient; entry: ConversationEntry }) {
  const { tags: library } = useRecentConversations(api, true);
  const [chosen, setChosen] = useState<TagId[]>(() => entry.tags?.map((tag) => tag.id) ?? []);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const failed = () => showToast({ title: t`That change couldn't be saved`, tone: "danger" });
  const save = (next: TagId[]) => {
    setChosen(next);
    organizeConversation(api, entry.sessionId, { tags: next }).catch(failed);
  };
  const shown = library.filter((tag) => fold(tag.name).includes(fold(query)));
  const name = TagName.safeParse(query);
  const exact = library.some((tag) => fold(tag.name) === fold(query));
  const make = () => {
    if (!name.success || exact) return;
    createTag(api, { name: name.data, color: nextColour(library) }).then((tag) => {
      setQuery("");
      save([tag.id]);
    }, failed);
  };
  return (
    <div className="tag-chooser">
      <TagSwatches standalone chosen={chosen} onSelect={(tag) => save(toggledTag(chosen, tag))} />
      <TextField
        aria-label={t`Find or make a tag`}
        placeholder={t`Find or make a tag`}
        maxLength={TAG_NAME_CHARS}
        autoComplete="off"
        enterKeyHint="done"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          const only = shown.length === 1 ? shown[0] : undefined;
          if (!exact && name.success) make();
          else if (only && !chosen.includes(only.id)) save([only.id]);
        }}
      />
      <div className="tag-chooser-list">
        {shown.map((tag) =>
          editing === tag.id ? (
            <TagEditor
              key={tag.id}
              api={api}
              tag={tag}
              library={library}
              onDone={() => setEditing(null)}
            />
          ) : (
            <div key={tag.id} className="tag-chooser-row">
              <Button
                variant="quiet"
                className="tag-chooser-pick"
                aria-pressed={chosen.includes(tag.id)}
                onClick={() => save(toggledTag(chosen, tag.id))}
              >
                <TagDot tag={tag.color} />
                <span className="tag-chooser-name">{tag.name}</span>
                {chosen.includes(tag.id) && <Icon name="check" size={16} />}
              </Button>
              <IconButton
                icon="settings"
                size={28}
                label={t`Edit ${tag.name}`}
                onClick={() => setEditing(tag.id)}
              />
            </div>
          ),
        )}
        {query.trim() && !exact && (
          <Button
            variant="quiet"
            icon="plus"
            className="tag-chooser-make"
            disabledReason={name.success ? undefined : t`Use one line of text`}
            onClick={make}
          >
            {t`Make the tag “${query.trim()}”`}
          </Button>
        )}
        {!library.length && !query.trim() && (
          <p className="tag-chooser-note">{t`Type a name to make your first tag.`}</p>
        )}
      </div>
    </div>
  );
}

function TagEditor({
  api,
  tag,
  library,
  onDone,
}: {
  api: ApiClient;
  tag: NamedTag;
  library: readonly NamedTag[];
  onDone(): void;
}) {
  const [name, setName] = useState(tag.name);
  const [deleting, setDeleting] = useState(false);
  const taken = library.some((each) => each.id !== tag.id && fold(each.name) === fold(name));
  const valid = TagName.safeParse(name);
  const problem = taken
    ? t`Another tag has that name.`
    : valid.success
      ? undefined
      : t`Use one line of text`;
  const failed = () => showToast({ title: t`That change couldn't be saved`, tone: "danger" });
  const rename = () => {
    if (problem || !valid.success || valid.data === tag.name) return onDone();
    changeTag(api, tag.id, { name: valid.data }).then(onDone, failed);
  };
  return (
    <div className="tag-editor">
      <TextField
        aria-label={t`Tag name`}
        maxLength={TAG_NAME_CHARS}
        autoComplete="off"
        enterKeyHint="done"
        autoFocus
        value={name}
        aria-invalid={!!problem || undefined}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            rename();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onDone();
          }
        }}
      />
      {problem && (
        <p className="tag-editor-problem" role="alert">
          {problem}
        </p>
      )}
      <ColourChoice
        value={tag.color}
        onSelect={(colour) => {
          if (colour !== tag.color) changeTag(api, tag.id, { color: colour }).catch(failed);
        }}
      />
      <div className="tag-editor-actions">
        {deleting ? (
          <>
            <span className="tag-editor-ask">{t`Take “${tag.name}” off every conversation?`}</span>
            <Button size="sm" variant="quiet" onClick={() => setDeleting(false)}>
              {t`Cancel`}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => deleteTag(api, tag.id).then(onDone, failed)}
            >
              {t`Delete tag`}
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="quiet" icon="trash" onClick={() => setDeleting(true)}>
              {t`Delete tag`}
            </Button>
            <Button size="sm" onClick={rename}>
              {t`Done`}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
