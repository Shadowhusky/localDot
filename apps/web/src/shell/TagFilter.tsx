import type { TagId, TagOnConversation } from "@localdot/protocol";
import { t } from "../i18n/index.ts";
import { Button } from "../ui/Button.tsx";
import { TagDot, tagName } from "../ui/ConversationTag.tsx";

// Above a list: a toggle for each tag its conversations carry, showing only those with it, and what
// sorts them into tags with the user's model.
export function TagFilter({
  tags,
  tagged,
  onTag,
  onSort,
}: {
  tags: readonly TagOnConversation[];
  tagged: TagId | null;
  onTag(tag: TagId | null): void;
  onSort?(): void;
}) {
  if (!tags.length && !onSort) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a row of toggles, not a form's fieldset.
    <div className="conversations-tags" role="group" aria-label={t`Show only a tag`}>
      {tags.map((each) => (
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
    </div>
  );
}
