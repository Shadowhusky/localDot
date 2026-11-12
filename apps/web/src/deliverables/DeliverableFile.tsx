import { canOpenOnMac, type FileVersion, fileKind, viewerKind } from "@localdot/protocol";
import { type Ref, useCallback, useId, useRef, useState } from "react";
import type { AgentResult } from "../agent/model.ts";
import type { FileState, ResultDownloads } from "../agent/ResultFiles.tsx";
import { bytes } from "../copy/format.ts";
import { t } from "../i18n/index.ts";
import type { ApiClient } from "../lib/api.ts";
import { Button } from "../ui/Button.tsx";
import { FileCard, FileRow } from "../ui/Card.tsx";
import { Collapse } from "../ui/Disclosure.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Menu, MenuGroup, MenuItem } from "../ui/Menu.tsx";
import { triggerProps } from "../ui/Popover.tsx";
import { Select } from "../ui/Select.tsx";
import { Spinner } from "../ui/Spinner.tsx";
import { showToast } from "../ui/Toast.tsx";
import { CompareSheet } from "./CompareSheet.tsx";
import { FilePreview, MediaPreview } from "./FilePreview.tsx";
import { kindLabel } from "./kind-label.ts";
import { openHere } from "./open-here.ts";
import { requestRevise } from "./revise-draft.ts";
import { usePreview } from "./usePreview.ts";
import { useVersions } from "./useVersions.ts";
import {
  comparePair,
  findVersion,
  type ShownVersion,
  versionDetail,
  versionKey,
} from "./versions.ts";
import { entryKey, useFileViewer } from "./viewer/scope.tsx";

type ResultFile = AgentResult["files"][number];

export interface DeliverableFileProps {
  measure?: Ref<HTMLLIElement>;
  index?: number;
  api: ApiClient;
  // The task that handed the file over, and the result it came with.
  sessionId: string;
  resultId: string;
  file: ResultFile;
  downloads: Pick<ResultDownloads, "state" | "busy" | "request" | "cancel" | "sessionId">;
  // Changes when the conversation gets another result, so the versions are read again.
  refresh: number;
  defaultOpen?: boolean;
  // localDot is open on this Mac, where the daemon lets a file open in its own app.
  onMac: boolean;
  // Revise goes to the composer; without one in reach it is not offered.
  revisable?: boolean;
  // One line, as in the chat, where an image shows its own picture on the row's tile.
  compact?: boolean;
  // When it was handed over, where a list holds more than one task's files.
  when?: string;
}

// A file dot handed over: a row to open its preview, with Open and a menu that also holds Download
// (and, where a row is too narrow for Open, is all there is), and under it, what it looks like, its
// versions, and Revise and Compare.
export function DeliverableFile({
  measure,
  index,
  api,
  sessionId,
  resultId,
  file,
  downloads,
  refresh,
  defaultOpen = false,
  onMac,
  revisable = true,
  compact = false,
  when,
}: DeliverableFileProps) {
  const panel = useId();
  const row = useRef<HTMLLIElement | null>(null);
  const attach = useCallback(
    (node: HTMLLIElement | null) => {
      row.current = node;
      if (typeof measure === "function") measure(node);
      else if (measure) measure.current = node;
    },
    [measure],
  );
  const [open, setOpen] = useState(defaultOpen);
  const [shown, setShown] = useState<ShownVersion>({ sessionId, version: file.version ?? null });
  const [attempt, setAttempt] = useState(0);
  const [opening, setOpening] = useState(false);
  const [menu, setMenu] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const [comparing, setComparing] = useState<{
    pair: [FileVersion, FileVersion];
    open: boolean;
  } | null>(null);
  const versions = useVersions(api, sessionId, file.name, refresh) ?? [];
  const viewer = useFileViewer();
  // A file listed without its number (from a recording's summary) is the newest of its task.
  const current =
    findVersion(versions, shown) ??
    (shown.version === null && file.version === undefined
      ? versions.findLast((v) => v.sessionId === shown.sessionId && v.available)
      : undefined);
  const newest = !current || current === versions.at(-1);
  const kind = fileKind(file.name);
  const shows = viewerKind(file.name);
  // The tile's picture is the preview itself, so it loads while the row is closed.
  const picture = compact && kind === "image";
  const preview = usePreview(
    api,
    row,
    shown.sessionId,
    file.name,
    shown.version,
    (open || picture) && (kind !== "attachment" || shows === "details"),
    attempt,
  );
  const pair = comparePair(file.name, versions, current);
  const state: FileState | undefined = downloads.state(resultId, file);
  // A version asked for by the user speaks for itself; the file's own may be known to be gone.
  const gone = current ? current.available === false : !!file.gone;
  const own = shown.sessionId === sessionId && shown.version === (file.version ?? null);

  const meta =
    state === "busy"
      ? t`Downloading…`
      : state === "failed"
        ? t`Couldn't download. Try again.`
        : gone
          ? t`No longer available`
          : [
              bytes(current?.bytes ?? file.bytes),
              versions.length > 1 && current ? `v${current.label}` : null,
              when,
            ]
              .filter(Boolean)
              .join(" · ");
  const openOnMac = async () => {
    setOpening(true);
    await openHere(api, shown.sessionId, file.name, shown.version);
    setOpening(false);
  };
  const revise = () => {
    if (
      !requestRevise({
        link: { sessionId: shown.sessionId, name: file.name, version: shown.version },
        label: current?.label ?? 1,
        newest,
      })
    )
      showToast({ title: t`Open the conversation to revise this file.`, tone: "neutral" });
  };
  const downloadReason = !downloads.sessionId
    ? t`This task is no longer available.`
    : gone
      ? t`This version is no longer available.`
      : downloads.busy && state !== "busy"
        ? t`Another download is still running.`
        : undefined;
  const openReason = gone ? t`This version is no longer available.` : undefined;
  const download = () => void downloads.request(resultId, file, own ? undefined : shown);
  const openViewer =
    viewer &&
    (() =>
      viewer(entryKey({ resultId, file }), {
        sessionId: shown.sessionId,
        version: shown.version,
        bytes: current?.bytes ?? file.bytes,
        ...(versions.length > 1 && current ? { label: current.label } : {}),
      }));
  const opener = openViewer ?? (onMac && canOpenOnMac(file.name) ? openOnMac : undefined);
  const openLabel = viewer ? t`Open ${file.name}` : t`Open ${file.name} on your Mac`;
  // Under the row, Open does something the card doesn't: the Mac's own app, or a viewer that can
  // show more than this card again.
  const opensMore =
    onMac && canOpenOnMac(file.name) ? openOnMac : shows !== "details" ? openViewer : undefined;
  const card = {
    name: file.name,
    meta: [kindLabel(file.name), bytes(current?.bytes ?? file.bytes)].join(" · "),
    actions: (
      <>
        {opensMore && (
          <Button
            size="sm"
            busy={opening}
            disabledReason={openReason}
            onClick={() => void opensMore()}
          >
            {t`Open`}
          </Button>
        )}
        <Button
          size="sm"
          icon={state === "done" ? "check" : "download"}
          busy={state === "busy"}
          disabledReason={downloadReason}
          onClick={download}
        >
          {t`Download`}
        </Button>
      </>
    ),
  };

  return (
    <li ref={attach} data-index={index} className="deliverable" aria-label={file.name}>
      <FileRow
        name={file.name}
        meta={meta}
        compact={compact}
        thumbnail={
          picture && preview.state === "image" && <img src={preview.url} alt="" draggable={false} />
        }
        expanded={open}
        controls={panel}
        toggleLabel={open ? t`Hide ${file.name}` : t`Show ${file.name}`}
        onToggle={() => setOpen((was) => !was)}
        actions={
          <>
            {opener && (
              <Button
                size="sm"
                className="ui-file-open"
                busy={opening}
                aria-label={openLabel}
                disabledReason={openReason}
                onClick={() => void opener()}
              >
                {t`Open`}
              </Button>
            )}
            <span className="result-file-action" data-state={state}>
              {state === "busy" && <Spinner className="result-file-ring" />}
              {opener && !state ? (
                <IconButton
                  ref={more}
                  icon="more-horizontal"
                  label={t`More for ${file.name}`}
                  {...triggerProps("menu", menu)}
                  onClick={() => setMenu(true)}
                />
              ) : (
                <IconButton
                  icon={state === "busy" ? "x" : state === "done" ? "check" : "download"}
                  label={state === "busy" ? t`Cancel download` : t`Download ${file.name}`}
                  disabledReason={state === "busy" ? undefined : downloadReason}
                  onClick={() => (state === "busy" ? downloads.cancel() : download())}
                />
              )}
            </span>
            {opener && (
              <Menu
                open={menu}
                onClose={() => setMenu(false)}
                anchor={more}
                align="end"
                label={t`Actions for ${file.name}`}
              >
                {/* The whole name, for a finger that can't hover over a shortened one. */}
                <MenuGroup label={file.name}>
                  <MenuItem
                    icon="expand"
                    disabledReason={openReason}
                    onSelect={() => void opener()}
                  >
                    {viewer ? t`Open` : t`Open on your Mac`}
                  </MenuItem>
                  <MenuItem icon="download" disabledReason={downloadReason} onSelect={download}>
                    {t`Download`}
                  </MenuItem>
                </MenuGroup>
              </Menu>
            )}
          </>
        }
      />
      <Collapse id={panel} open={open} className="deliverable-panel" fit>
        <div className="deliverable-body">
          {shows === "video" || shows === "audio" ? (
            gone ? (
              <FileCard {...card} problem={t`This version is no longer available.`} />
            ) : (
              <MediaPreview
                api={api}
                file={{ sessionId: shown.sessionId, name: file.name, version: shown.version }}
                kind={shows}
                card={card}
              />
            )
          ) : (
            <FilePreview
              state={preview}
              kind={kind}
              {...card}
              onRetry={() => setAttempt((n) => n + 1)}
            />
          )}
          {(revisable || pair || versions.length > 1) && (
            <div className="deliverable-tools">
              {revisable && (
                <Button
                  variant="quiet"
                  size="sm"
                  icon="compose"
                  disabledReason={gone ? t`This version is no longer available.` : undefined}
                  onClick={revise}
                >
                  {t`Revise`}
                </Button>
              )}
              {pair && (
                <Button
                  variant="quiet"
                  size="sm"
                  icon="file-diff"
                  onClick={() => setComparing({ pair, open: true })}
                >
                  {t`Compare v${pair[0].label} → v${pair[1].label}`}
                </Button>
              )}
              {versions.length > 1 && current && (
                <Select
                  appearance="inline"
                  size="sm"
                  className="deliverable-version"
                  aria-label={t`Version of ${file.name}`}
                  value={versionKey(current)}
                  shown={t`v${current.label} of ${versions.length}`}
                  items={versions.map((v) => ({
                    value: versionKey(v),
                    label: `v${v.label}`,
                    description: versionDetail(v),
                    ...(v.available ? {} : { disabledReason: t`Replaced by a later version` }),
                  }))}
                  onValueChange={(key) => {
                    const chosen = versions.find((v) => versionKey(v) === key);
                    if (chosen) setShown({ sessionId: chosen.sessionId, version: chosen.version });
                  }}
                />
              )}
            </div>
          )}
        </div>
      </Collapse>
      {comparing && (
        <CompareSheet
          api={api}
          sessionId={sessionId}
          name={file.name}
          from={comparing.pair[0]}
          to={comparing.pair[1]}
          open={comparing.open}
          onClose={() => setComparing((was) => was && { ...was, open: false })}
        />
      )}
    </li>
  );
}
