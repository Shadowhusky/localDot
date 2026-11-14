import { isComputerPath } from "@localdot/protocol";
import { useMemo, useRef, useState } from "react";
import { bytes } from "../copy/format.ts";
import { useComputerDownloads } from "../deliverables/useComputerDownloads.ts";
import { FileViewer } from "../deliverables/viewer/FileViewer.tsx";
import {
  type ComputerEntry,
  isLocalEntry,
  type LocalEntry,
  type ViewerDownloads,
} from "../deliverables/viewer/scope.tsx";
import { t, tr } from "../i18n/index.ts";
import type { ApiClient } from "../lib/api.ts";
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

type DraftEntry = LocalEntry | ComputerEntry;

// A draft's files in the viewer: each from the copy on this device, or, for one a message of this
// task carried back into the draft, from the computer.
function useDraftEntries(rows: readonly UploadRow[], sessionId: string | null | undefined) {
  return useMemo(
    () =>
      rows.flatMap((row): { id: number; entry: DraftEntry }[] =>
        row.text !== undefined
          ? []
          : row.file
            ? [{ id: row.id, entry: { localId: String(row.id), local: row.file } }]
            : row.path && sessionId && isComputerPath(row.path)
              ? [{ id: row.id, entry: { sessionId, path: row.path } }]
              : [],
      ),
    [rows, sessionId],
  );
}

// The files added to a draft, over its field. Each chip says where its upload stands, and pressing
// it opens the file in the viewer.
export function AttachmentChips({
  rows,
  api,
  sessionId,
  onRemove,
  onRetry,
}: {
  rows: readonly UploadRow[];
  api: ApiClient;
  // The task a follow-up goes to, whose computer holds the files its messages carried.
  sessionId?: string | null;
  onRemove(id: number): void;
  onRetry?(id: number): void;
}) {
  const [reading, setReading] = useState<number | null>(null);
  const opened = useDraftEntries(rows, sessionId);
  const entries = useMemo(() => opened.map((item) => item.entry), [opened]);
  const [viewing, setViewing] = useState<{ index: number; open: boolean } | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const computer = useComputerDownloads(api);
  const downloads = useMemo<ViewerDownloads<DraftEntry>>(
    () => ({
      state: (entry) => (isLocalEntry(entry) ? undefined : computer.state(entry)),
      blocked: (entry) => (isLocalEntry(entry) ? undefined : computer.blocked(entry)),
      request: (entry, version) => {
        if (!isLocalEntry(entry)) computer.request(entry, version);
      },
    }),
    [computer],
  );
  const view = (id: number, from: HTMLElement) => {
    const index = opened.findIndex((item) => item.id === id);
    if (index < 0) return;
    trigger.current = from;
    setViewing({ index, open: true });
  };
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
            data-opens={
              row.text !== undefined || opened.some((item) => item.id === row.id) ? "" : undefined
            }
          >
            {row.text !== undefined ? (
              <HitButton
                className="file-chip-hit"
                label={t`Read ${row.label ?? row.name}`}
                onClick={() => setReading(row.id)}
              />
            ) : (
              opened.some((item) => item.id === row.id) && (
                <HitButton
                  className="file-chip-hit"
                  label={t`Open ${row.name}`}
                  onClick={(from) => view(row.id, from)}
                />
              )
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
      {viewing && entries[viewing.index] && (
        <FileViewer
          api={api}
          entries={entries}
          index={viewing.index}
          open={viewing.open}
          downloads={downloads}
          onMac={false}
          returnFocus={trigger}
          onIndex={(index) => setViewing((was) => was && { ...was, index })}
          onClose={() => setViewing((was) => was && { ...was, open: false })}
        />
      )}
    </div>
  );
}
