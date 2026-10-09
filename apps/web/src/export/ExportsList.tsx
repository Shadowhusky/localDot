import type { HostExport } from "@localdot/protocol";
import { useId, useMemo, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { ReplayImage } from "../replay/ReplayImage.tsx";
import { HANDHELD } from "../shell/layout.ts";
import { Button } from "../ui/Button.tsx";
import { Collapse } from "../ui/Disclosure.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { ListRow } from "../ui/ListRow.tsx";
import { useMediaQuery } from "../ui/media.ts";
import { Progress } from "../ui/Progress.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import { exportGlyph, exportMeta, exportRunning } from "./exports-view.ts";
import { type HostExports, useHostExports } from "./host-exports.ts";
import { downloadFile } from "./sink.ts";

// The newest few show; the rest open under them.
const SHOWN = 3;

// The videos the host made, or is making, at the head of Replay's library: each can be saved,
// cancelled while it is made, tried again after a failure, or removed.
export function ExportsList({
  api,
  host,
  cover,
}: {
  api: ApiClient;
  host: HostExports;
  // The picture a recording's row shows, to show beside its videos.
  cover(sessionId: string): string | null;
}) {
  const { exports } = useHostExports(host);
  const phone = useMediaQuery(HANDHELD);
  const [all, setAll] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const heading = useId();
  const rest = useId();
  const now = useMemo(() => new Date(), []);
  if (exports.length === 0) return null;
  const act = (id: string, work: Promise<unknown>) => {
    setFailed(null);
    void work.catch(() => setFailed(id));
  };
  const row = (record: HostExport) => (
    <ExportRow
      key={record.id}
      api={api}
      record={record}
      cover={cover(record.sessionId)}
      now={now}
      failed={failed === record.id}
      phone={phone}
      onSave={() =>
        act(
          record.id,
          host.link(record.id).then((href) => downloadFile(href, record.name)),
        )
      }
      onCancel={() => act(record.id, host.cancel(record.id))}
      onRetry={() => act(record.id, host.retry(record.id))}
      onRemove={() => act(record.id, host.remove(record.id))}
    />
  );
  return (
    <section className="replay-day export-list" aria-labelledby={heading}>
      <h3 id={heading} className="replay-day-title">
        Exported videos
      </h3>
      <ul className="replay-day-list">{exports.slice(0, SHOWN).map(row)}</ul>
      {exports.length > SHOWN && (
        <>
          <Collapse open={all} id={rest}>
            <ul className="replay-day-list">{exports.slice(SHOWN).map(row)}</ul>
          </Collapse>
          <Button
            size="sm"
            variant="quiet"
            className="export-list-more"
            aria-expanded={all}
            aria-controls={rest}
            onClick={() => setAll((open) => !open)}
          >
            {all ? "Show fewer" : `Show all ${exports.length}`}
          </Button>
        </>
      )}
    </section>
  );
}

function ExportRow({
  api,
  record,
  cover,
  now,
  failed,
  phone,
  onSave,
  onCancel,
  onRetry,
  onRemove,
}: {
  api: ApiClient;
  record: HostExport;
  cover: string | null;
  now: Date;
  failed: boolean;
  // A phone swipes a row away instead of showing its trash button.
  phone: boolean;
  onSave(): void;
  onCancel(): void;
  onRetry(): void;
  onRemove(): void;
}) {
  const glyph = exportGlyph(record);
  const running = exportRunning(record);
  return (
    <li className="export-row" data-phase={record.phase}>
      <ListRow
        title={record.name}
        thumbnail={
          <>
            <ReplayImage api={api} sessionId={record.sessionId} frameId={cover} />
            <span className="export-row-badge">
              {running ? (
                <Progress
                  variant="ring"
                  size={24}
                  label="Making the video"
                  value={record.total ? record.done : undefined}
                  max={record.total || 1}
                />
              ) : record.phase === "done" ? (
                <span className="export-row-format">{record.request.format}</span>
              ) : null}
            </span>
          </>
        }
        meta={
          <>
            <StatusGlyph state={glyph.state} label={glyph.label} />
            <span className="num" role={failed ? "alert" : undefined}>
              {failed ? "That didn't work. Try again." : exportMeta(record, now)}
            </span>
          </>
        }
        swipe={
          phone && !running
            ? { label: "Remove", accessibleLabel: `Remove ${record.name}`, onAction: onRemove }
            : undefined
        }
        actions={
          running ? (
            <IconButton
              size={28}
              icon="x"
              label={`Stop making ${record.name}`}
              onClick={onCancel}
            />
          ) : (
            <>
              {record.phase === "done" ? (
                <IconButton
                  size={28}
                  icon="download"
                  label={`Save ${record.name}`}
                  onClick={onSave}
                />
              ) : (
                <Button size="sm" onClick={onRetry}>
                  Try again
                </Button>
              )}
              {!phone && (
                <IconButton
                  size={28}
                  icon="trash"
                  label={`Remove ${record.name}`}
                  onClick={onRemove}
                />
              )}
            </>
          )
        }
      />
    </li>
  );
}
