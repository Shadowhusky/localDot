import { useRef, useState } from "react";
import { bytes } from "../copy/format.ts";
import { t, tr } from "../i18n/index.ts";
import { Button } from "../ui/Button.tsx";
import { HitButton } from "../ui/HitButton.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import { Spinner } from "../ui/Spinner.tsx";
import { VisuallyHidden } from "../ui/VisuallyHidden.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { FileName } from "./ResultFiles.tsx";
import type { UploadRow } from "./useUploads.ts";

const STATUS: Record<UploadRow["phase"], string> = {
  pending: tr("Waiting"),
  uploading: tr("Uploading…"),
  placing: tr("Saving to computer…"),
  complete: tr("Uploaded to Downloads"),
  uncertain: tr("Paused"),
  refused: tr("Not uploaded"),
};

// What a long text moved out of the field says, opened from its chip.
function LongTextSheet({ row, onClose }: { row?: UploadRow; onClose(): void }) {
  const shown = useRef(row);
  if (row) shown.current = row;
  const text = shown.current?.text ?? "";
  return (
    <Sheet
      open={!!row}
      onClose={onClose}
      modal
      title={shown.current?.label}
      doneLabel={t`Done`}
      footer={<CopyButton text={text} label={t`Copy this text`} />}
    >
      <pre className="composer-text-view">{text}</pre>
    </Sheet>
  );
}

// The files added to a draft, over its field. Each chip says where its upload stands.
export function AttachmentChips({
  rows,
  onRemove,
  onRetry,
}: {
  rows: readonly UploadRow[];
  onRemove(id: number): void;
  onRetry?(id: number): void;
}) {
  const [reading, setReading] = useState<number | null>(null);
  // Each reason once: the chips already say which files it applies to.
  const reasons = [...new Set(rows.flatMap((row) => (row.explanation ? [row.explanation] : [])))];
  return (
    <div className="file-chips-block">
      <ul className="file-chips" aria-label={t`Attached files`}>
        {rows.map((row) => (
          <li
            key={row.id}
            className="file-chip"
            data-phase={row.phase}
            data-opens={row.text !== undefined ? "" : undefined}
          >
            {row.text !== undefined && (
              <HitButton
                className="file-chip-hit"
                label={t`Read ${row.label ?? row.name}`}
                onClick={() => setReading(row.id)}
              />
            )}
            {row.preview && (
              <img className="file-chip-thumb" src={row.preview} alt="" decoding="async" />
            )}
            {row.phase === "uploading" || row.phase === "placing" || row.phase === "pending" ? (
              <Spinner size={12} className="file-chip-icon" />
            ) : row.preview && row.phase === "complete" ? null : (
              <Icon
                name={row.phase === "complete" ? "file" : "circle-alert"}
                size={12}
                className="file-chip-icon"
              />
            )}
            <FileName name={row.label ?? row.name} />
            {row.phase === "complete" ? (
              <>
                {row.bytes !== undefined && (
                  <span className="file-chip-meta num" aria-hidden="true">
                    {bytes(row.bytes)}
                  </span>
                )}
                <VisuallyHidden>{STATUS.complete}</VisuallyHidden>
              </>
            ) : (
              <span className="file-chip-meta num">
                {row.phase === "uploading" && row.bytes
                  ? `${Math.floor(((row.uploaded ?? 0) / row.bytes) * 100)}% · ${bytes(row.bytes)}`
                  : STATUS[row.phase]}
              </span>
            )}
            {(row.phase === "uncertain" || row.phase === "refused") && onRetry && (
              <Button
                variant="quiet"
                size="sm"
                className="file-chip-retry"
                onClick={() => onRetry(row.id)}
                aria-label={t`Retry ${row.name}`}
              >
                {t`Retry`}
              </Button>
            )}
            <IconButton
              className="file-chip-remove"
              icon="x"
              size={24}
              label={t`Remove ${row.name}`}
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
      <LongTextSheet
        row={rows.find((row) => row.id === reading)}
        onClose={() => setReading(null)}
      />
    </div>
  );
}
