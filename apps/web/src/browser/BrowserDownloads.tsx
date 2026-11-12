import { useEffect, useRef, useState } from "react";
import type { QuarantineItem } from "../../../../packages/protocol/src/quarantine.ts";
import { count } from "../copy/format.ts";
import { t, tc, tr } from "../i18n/index.ts";
import type { ApiClient } from "../lib/api.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import { changeDownload, listDownloads } from "./download-api.ts";
import "./downloads.css";

type Decision = { item: QuarantineItem; action: "release" | "discard" };
const REFRESH_FAILED = t`Downloads could not be refreshed. Check the computer and try again.`;
const KIND: Record<QuarantineItem["kind"], string> = {
  document: tr("Document"),
  image: tr("Image"),
  archive: tr("Archive"),
  program: tr("Program"),
  other: tr("File"),
};
const decisionTitle = ({ item, action }: Decision) =>
  action === "discard"
    ? t`Discard ${item.name}?`
    : item.state === "releasing"
      ? t`Check whether ${item.name} arrived?`
      : t`Save ${item.name} to your computer?`;
const size = (bytes: number) =>
  bytes < 1024
    ? t`${bytes} bytes`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;
const stateLabel = (item: QuarantineItem) =>
  item.state === "held"
    ? t`Waiting for your review`
    : item.state === "releasing"
      ? t`Delivery needs checking`
      : item.state === "released"
        ? t`Saved to ${item.receipt.path}`
        : item.state === "failed"
          ? t`File verification failed`
          : t`Discarded`;

export function BrowserDownloads({
  api,
  cellId,
  releaseReady,
  onCount,
}: {
  api: ApiClient;
  cellId: string;
  releaseReady: boolean;
  // How many downloads the list holds, as it changes, and none once it is gone.
  onCount?(count: number): void;
}) {
  const [items, setItems] = useState<QuarantineItem[]>([]);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [limit, setLimit] = useState(12);
  const owner = useRef(0);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const poll = useRef<() => Promise<void>>(async () => {});
  const operation = useRef<AbortController | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const epoch = ++owner.current;
    const abort = new AbortController();
    let loading: Promise<void> | undefined;
    // A computer that is still starting refuses the list, so a background failure counts only
    // after a list has loaded once; a refresh the user asked for always reports.
    let loaded = false;
    let asked = false;
    setItems([]);
    setDecision(null);
    setPending(false);
    setMessage(null);
    setLimit(12);
    const load = (explicit = false) => {
      asked ||= explicit;
      if (loading) return loading;
      loading = (async () => {
        try {
          const next = await listDownloads(api, cellId, abort.signal);
          if (epoch === owner.current && !abort.signal.aborted) {
            loaded = true;
            setItems(next);
            setMessage((shown) => (shown === REFRESH_FAILED ? null : shown));
          }
        } catch {
          if (epoch === owner.current && !abort.signal.aborted && (loaded || asked))
            setMessage(REFRESH_FAILED);
        } finally {
          loading = undefined;
          asked = false;
        }
      })();
      return loading;
    };
    refresh.current = () => load(true);
    poll.current = () => load();
    void load();
    return () => {
      owner.current++;
      abort.abort();
      operation.current?.abort();
      operation.current = null;
    };
  }, [api, cellId]);
  const visible = items.filter((item) => item.state !== "discarded");
  const waiting = visible.filter(
    (item) => item.state === "held" || item.state === "releasing",
  ).length;
  const polling = releaseReady || waiting > 0;
  useEffect(() => onCount?.(visible.length), [onCount, visible.length]);
  useEffect(() => () => onCount?.(0), [onCount]);
  useEffect(() => {
    if (!polling) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await poll.current();
      if (!stopped) timer = setTimeout(() => void tick(), 2000);
    };
    timer = setTimeout(() => void tick(), 2000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [polling]);
  const current = decision && items.find((item) => item.id === decision.item.id);
  const matches = !!current && JSON.stringify(current) === JSON.stringify(decision?.item);
  const confirm = async () => {
    if (
      !decision ||
      !matches ||
      pending ||
      operation.current ||
      (decision.action === "release" && !releaseReady)
    )
      return;
    const epoch = owner.current,
      abort = new AbortController(),
      selected = decision;
    operation.current = abort;
    setPending(true);
    setMessage(null);
    try {
      const item = await changeDownload(api, cellId, selected.item, selected.action, abort.signal);
      if (epoch !== owner.current) return;
      setItems((rows) => rows.map((row) => (row.id === item.id ? item : row)));
      setMessage(
        item.state === "released"
          ? t`Saved ${item.name} to ${item.receipt.path}.`
          : item.state === "discarded"
            ? t`Discarded ${item.name}.`
            : t`The earlier transfer did not save this file. Review it again to release it.`,
      );
    } catch {
      if (epoch === owner.current)
        setMessage(t`Couldn't confirm that change. Refresh, then try again.`);
    } finally {
      if (epoch === owner.current) {
        operation.current = null;
        setPending(false);
        setDecision(null);
        await refresh.current();
      }
    }
  };
  const choose = (item: QuarantineItem, action: Decision["action"], element: HTMLButtonElement) => {
    trigger.current = element;
    setDecision({ item: structuredClone(item), action });
  };
  if (!visible.length && !message && !decision) return null;
  return (
    <section className="activity-section browser-downloads" aria-label={t`Browser downloads`}>
      <div className="activity-section-head">
        <h3>{t`Downloads`}</h3>
        <span className="activity-section-meta">
          {waiting ? t`${waiting} waiting` : count(visible.length, "file", "files")}
        </span>
      </div>
      {visible.slice(0, limit).map((item) => (
        <div
          key={item.id}
          className="activity-row download-row"
          data-state={item.state}
          data-testid="download-row"
        >
          <div className="activity-row-head">
            <StatusGlyph
              state={
                item.state === "released" ? "done" : item.state === "failed" ? "failed" : "todo"
              }
              label={stateLabel(item)}
            />
            <span className="activity-row-text">
              <span className="activity-row-title" title={item.name}>
                {item.name}
              </span>
            </span>{" "}
            <span className="activity-row-time num">{size(item.bytes)}</span>
          </div>
          <div className="download-detail">
            <p className="activity-detail-note">
              {stateLabel(item)} · {item.source}
              {item.state === "held" && item.recovery
                ? ` · ${t`The earlier transfer didn't save this file, so it needs a new review.`}`
                : ""}
            </p>
            {(item.state === "held" || item.state === "releasing" || item.state === "failed") && (
              <div className="activity-detail-actions">
                {(item.state === "held" || item.state === "releasing") && (
                  <Button
                    size="sm"
                    disabledReason={
                      !releaseReady
                        ? t`Turn the computer back on to release a file.`
                        : pending
                          ? t`Another download is being checked.`
                          : undefined
                    }
                    onClick={(event) => choose(item, "release", event.currentTarget)}
                  >
                    {item.state === "releasing" ? t`Check delivery` : t`Review`}
                  </Button>
                )}
                {(item.state === "held" || item.state === "failed") && (
                  <Button
                    size="sm"
                    variant="quiet"
                    disabledReason={pending ? t`Another download is being checked.` : undefined}
                    onClick={(event) => choose(item, "discard", event.currentTarget)}
                  >
                    {t`Discard`}
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      ))}
      <div className="activity-detail-actions download-actions">
        {visible.length > limit && (
          <Button variant="quiet" size="sm" onClick={() => setLimit((shown) => shown + 12)}>
            {t`Show more downloads`}
          </Button>
        )}
        <Button
          variant="quiet"
          size="sm"
          disabledReason={pending ? t`Another download is being checked.` : undefined}
          onClick={() => void refresh.current()}
        >
          {t`Refresh downloads`}
        </Button>
      </div>
      {message && (
        <p role="status" className="activity-detail-note download-message">
          {message}
        </p>
      )}
      <Dialog
        open={!!decision}
        onClose={() => {
          if (!pending) setDecision(null);
        }}
        anchor={trigger}
        title={decision ? decisionTitle(decision) : ""}
        description={
          !decision
            ? undefined
            : !matches
              ? t`This file changed since you opened it. Cancel, then review it again.`
              : decision.action === "discard"
                ? t`The held copy is removed. To get it back, download it again.`
                : decision.item.state === "releasing"
                  ? t`An earlier save may not have finished. Check whether it reached your computer.`
                  : t`dot downloaded this in its browser. It stays here until you choose.`
        }
        facts={
          decision
            ? [
                [t`Size`, size(decision.item.bytes)],
                [tc("source", "From"), decision.item.source],
                [t`Kind`, KIND[decision.item.kind]],
                ...(decision.action === "release"
                  ? ([[t`Saves to`, t`Downloads on your computer`]] as const)
                  : []),
                [
                  "SHA-256",
                  <span key="digest" className="download-digest">
                    {decision.item.sha256}
                  </span>,
                ],
              ]
            : undefined
        }
      >
        <Button
          variant="quiet"
          disabledReason={pending ? t`Wait for this to finish.` : undefined}
          onClick={() => setDecision(null)}
        >
          {t`Cancel`}
        </Button>
        {decision && (
          <Button
            variant={decision.action === "discard" ? "destructive" : "primary"}
            busy={pending}
            disabledReason={
              !matches
                ? t`This file changed. Review it again.`
                : decision.action === "release" && !releaseReady
                  ? t`Turn the computer back on to save a file.`
                  : undefined
            }
            onClick={() => void confirm()}
          >
            {decision.action === "discard"
              ? t`Discard`
              : decision.item.state === "releasing"
                ? t`Check delivery`
                : t`Save to computer`}
          </Button>
        )}
      </Dialog>
    </section>
  );
}
