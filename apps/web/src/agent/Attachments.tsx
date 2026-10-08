import { bytes } from "../copy/format.ts";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Spinner } from "../ui/Spinner.tsx";
import { VisuallyHidden } from "../ui/VisuallyHidden.tsx";
import { FileName } from "./ResultFiles.tsx";
import type { UploadRow } from "./useUploads.ts";

const STATUS: Record<UploadRow["phase"], string> = {
  pending: "Waiting",
  uploading: "Uploading…",
  complete: "Uploaded to Downloads",
  uncertain: "Unconfirmed",
  refused: "Not uploaded",
};

// The files added to a draft, over its field. Each chip says where its upload stands.
export function AttachmentChips({
  rows,
  onRemove,
}: {
  rows: readonly UploadRow[];
  onRemove(id: number): void;
}) {
  // Each reason once: the chips already say which files it applies to.
  const reasons = [...new Set(rows.flatMap((row) => (row.explanation ? [row.explanation] : [])))];
  return (
    <div className="file-chips-block">
      <ul className="file-chips" aria-label="Attached files">
        {rows.map((row) => (
          <li key={row.id} className="file-chip" data-phase={row.phase}>
            {row.phase === "uploading" || row.phase === "pending" ? (
              <Spinner size={12} className="file-chip-icon" />
            ) : (
              <Icon
                name={row.phase === "complete" ? "file" : "circle-alert"}
                size={12}
                className="file-chip-icon"
              />
            )}
            <FileName name={row.name} />
            {row.phase === "complete" ? (
              <>
                <span className="file-chip-meta num" aria-hidden="true">
                  {bytes(row.bytes)}
                </span>
                <VisuallyHidden>{STATUS.complete}</VisuallyHidden>
              </>
            ) : (
              <span className="file-chip-meta">{STATUS[row.phase]}</span>
            )}
            <IconButton
              className="file-chip-remove"
              icon="x"
              size={24}
              label={`Remove ${row.name}`}
              onClick={() => onRemove(row.id)}
            />
          </li>
        ))}
      </ul>
      {reasons.map((reason) => (
        <p key={reason} className="file-chips-note">
          {reason}
        </p>
      ))}
    </div>
  );
}

// The files a sent message carried, under its bubble.
export function SentFiles({ names }: { names: readonly string[] }) {
  return (
    <ul className="file-chips" data-sent="" aria-label="Attached files">
      {names.map((name) => (
        <li key={name} className="file-chip">
          <Icon name="file" size={12} className="file-chip-icon" />
          <FileName name={name} />
        </li>
      ))}
    </ul>
  );
}
