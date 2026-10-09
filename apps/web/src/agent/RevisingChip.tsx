import type { ReviseDraft } from "../deliverables/revise-draft.ts";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { FileName } from "./ResultFiles.tsx";

// Over the field while a message revises a file: which file and version, and a way to stop.
export function RevisingChip({ draft, onClear }: { draft: ReviseDraft; onClear(): void }) {
  return (
    <div className="file-chips-block">
      <p className="file-chips">
        <span className="file-chip" data-revising="">
          <Icon name="compose" size={12} className="file-chip-icon" />
          <span className="file-chip-meta">Revising</span>
          <FileName name={draft.link.name} />
          <span className="file-chip-meta num">v{draft.label}</span>
          <IconButton
            className="file-chip-remove"
            icon="x"
            size={24}
            label={`Stop revising ${draft.link.name}`}
            onClick={onClear}
          />
        </span>
      </p>
    </div>
  );
}
