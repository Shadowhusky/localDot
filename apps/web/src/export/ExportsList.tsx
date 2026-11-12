import type { HostExport } from "@localdot/protocol";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { MediaView } from "../deliverables/viewer/MediaView.tsx";
import { DotLoader } from "../dot/DotLoader.tsx";
import { t } from "../i18n/index.ts";
import type { ApiClient } from "../lib/api.ts";
import { ReplayImage } from "../replay/ReplayImage.tsx";
import { HANDHELD } from "../shell/layout.ts";
import { Sheet } from "../ui/Sheet.tsx";
import "../deliverables/viewer/viewer.css";
import { Button } from "../ui/Button.tsx";
import { Collapse } from "../ui/Disclosure.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { ListRow } from "../ui/ListRow.tsx";
import { foldAway } from "../ui/leave.ts";
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
  const { exports, failed: loadFailed } = useHostExports(host);
  const phone = useMediaQuery(HANDHELD);
  const [all, setAll] = useState(false);
  const [preview, setPreview] = useState<{ record: HostExport; open: boolean } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const heading = useId();
  const rest = useId();
  const now = useMemo(() => new Date(), []);
  if (exports.length === 0)
    return loadFailed ? (
      <p className="replay-tasks-note" role="alert">
        {t`Exported videos couldn’t load.`}{" "}
        <Button size="sm" variant="quiet" onClick={host.refresh}>
          {t`Try again`}
        </Button>
      </p>
    ) : null;
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
      onPreview={() => setPreview({ record, open: true })}
      onSave={() =>
        act(
          record.id,
          host.link(record.id).then((href) => downloadFile(href, record.name)),
        )
      }
      onCancel={() => act(record.id, host.cancel(record.id))}
      onRetry={() => act(record.id, host.retry(record.id))}
      onRemove={(row) =>
        act(
          record.id,
          host.remove(record.id, () => foldAway(row)),
        )
      }
    />
  );
  return (
    <>
      <section className="replay-day export-list" aria-labelledby={heading}>
        <h3 id={heading} className="replay-day-title">
          {t`Exported videos`}
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
              {all ? t`Show fewer` : t`Show all ${exports.length}`}
            </Button>
          </>
        )}
      </section>
      {preview && (
        <ExportPreview
          key={preview.record.id}
          record={preview.record}
          open={preview.open}
          host={host}
          onClose={() => setPreview((value) => value && { ...value, open: false })}
        />
      )}
    </>
  );
}

function ExportRow({
  api,
  record,
  cover,
  now,
  failed,
  phone,
  onPreview,
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
  onPreview(): void;
  onSave(): void;
  onCancel(): void;
  onRetry(): void;
  onRemove(row: HTMLElement | null): void;
}) {
  const item = useRef<HTMLLIElement>(null);
  const remove = () => onRemove(item.current);
  const glyph = exportGlyph(record);
  const running = exportRunning(record);
  return (
    <li ref={item} className="export-row" data-phase={record.phase}>
      <ListRow
        title={record.name}
        onSelect={record.phase === "done" ? onPreview : undefined}
        thumbnail={
          <>
            <ReplayImage api={api} sessionId={record.sessionId} frameId={cover} />
            <span className="export-row-badge">
              {running ? (
                <Progress
                  variant="ring"
                  size={24}
                  label={t`Making the video`}
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
              {failed ? t`That didn't work. Try again.` : exportMeta(record, now)}
            </span>
          </>
        }
        swipe={
          phone && !running
            ? { label: t`Remove`, accessibleLabel: t`Remove ${record.name}`, onAction: remove }
            : undefined
        }
        actions={
          running ? (
            <IconButton
              size={28}
              icon="x"
              label={t`Stop making ${record.name}`}
              onClick={onCancel}
            />
          ) : (
            <>
              {record.phase === "done" ? (
                <IconButton
                  size={28}
                  icon="download"
                  label={t`Save ${record.name}`}
                  onClick={onSave}
                />
              ) : (
                <Button size="sm" onClick={onRetry}>
                  {t`Try again`}
                </Button>
              )}
              {!phone && (
                <IconButton
                  size={28}
                  icon="trash"
                  label={t`Remove ${record.name}`}
                  onClick={remove}
                />
              )}
            </>
          )
        }
      />
    </li>
  );
}

function ExportPreview({
  open,
  record,
  host,
  onClose,
}: {
  record: HostExport;
  open: boolean;
  host: HostExports;
  onClose(): void;
}) {
  const media = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) media.current?.querySelector("video")?.pause();
  }, [open]);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry starts a fresh preview request.
  useEffect(() => {
    if (!open) return;
    let active = true;
    setFailed(false);
    setUrl(null);
    void host.link(record.id).then(
      (href) => {
        if (active) setUrl(`${href}?preview=1`);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [host, record.id, attempt, open]);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={record.name}
      size="wide"
      modal
      className="export-preview"
      footer={
        <Button
          icon="download"
          onClick={() => {
            void host
              .link(record.id)
              .then((href) => downloadFile(href, record.name))
              .catch(() => setFailed(true));
          }}
        >
          {t`Download video`}
        </Button>
      }
    >
      {failed ? (
        <div role="alert" className="export-preview-error">
          <p>{t`The video couldn’t load. Try again, or download it to watch.`}</p>
          <Button
            onClick={() => {
              setUrl(null);
              setAttempt((value) => value + 1);
            }}
          >
            {t`Try again`}
          </Button>
        </div>
      ) : url ? (
        <div ref={media} className="export-preview-media">
          <MediaView
            key={url}
            url={url}
            kind="video"
            name={record.name}
            onError={() => setFailed(true)}
          />
        </div>
      ) : (
        <DotLoader label={t`Opening video`} />
      )}
    </Sheet>
  );
}
