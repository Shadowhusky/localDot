import { canOpenOnMac, type FileVersion, fileKind, viewerKind } from "@localdot/protocol";
import { useId, useRef, useState } from "react";
import type { AgentResult } from "../agent/model.ts";
import type { FileState, ResultDownloads } from "../agent/ResultFiles.tsx";
import { bytes } from "../copy/format.ts";
import type { ApiClient } from "../lib/api.ts";
import { Button } from "../ui/Button.tsx";
import { FileRow } from "../ui/Card.tsx";
import { Collapse } from "../ui/Disclosure.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Select } from "../ui/Select.tsx";
import { Spinner } from "../ui/Spinner.tsx";
import { showToast } from "../ui/Toast.tsx";
import { CompareSheet } from "./CompareSheet.tsx";
import { FilePreview } from "./FilePreview.tsx";
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
}

// A file dot handed over: a row to open its preview, download it or open it on the Mac, and under
// it, what it looks like, its versions, and Revise and Compare.
export function DeliverableFile({
  api,
  sessionId,
  resultId,
  file,
  downloads,
  refresh,
  defaultOpen = false,
  onMac,
  revisable = true,
}: DeliverableFileProps) {
  const panel = useId();
  const body = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(defaultOpen);
  const [shown, setShown] = useState<ShownVersion>({ sessionId, version: file.version ?? null });
  const [attempt, setAttempt] = useState(0);
  const [opening, setOpening] = useState(false);
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
  const preview = usePreview(
    api,
    body,
    shown.sessionId,
    file.name,
    shown.version,
    open && (kind !== "attachment" || viewerKind(file.name) === "details"),
    attempt,
  );
  const pair = comparePair(file.name, versions, current);
  const state: FileState | undefined = downloads.state(resultId, file);
  const gone = current?.available === false;
  const own = shown.sessionId === sessionId && shown.version === (file.version ?? null);

  const meta =
    state === "busy"
      ? "Downloading…"
      : state === "failed"
        ? "Couldn't download. Try again."
        : [
            bytes(current?.bytes ?? file.bytes),
            versions.length > 1 && current ? `v${current.label}` : null,
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
      showToast({ title: "Open the conversation to revise this file.", tone: "neutral" });
  };
  const downloadReason = !downloads.sessionId
    ? "This task is no longer available."
    : gone
      ? "This version is no longer available."
      : downloads.busy && state !== "busy"
        ? "Another download is still running."
        : undefined;

  return (
    <li className="deliverable" aria-label={file.name}>
      <FileRow
        name={file.name}
        meta={meta}
        expanded={open}
        controls={panel}
        toggleLabel={`${open ? "Hide" : "Show"} ${file.name}`}
        onToggle={() => setOpen((was) => !was)}
        actions={
          <>
            {viewer ? (
              <Button
                size="sm"
                aria-label={`Open ${file.name}`}
                disabledReason={gone ? "This version is no longer available." : undefined}
                onClick={() =>
                  viewer(entryKey({ resultId, file }), {
                    sessionId: shown.sessionId,
                    version: shown.version,
                    bytes: current?.bytes ?? file.bytes,
                    ...(versions.length > 1 && current ? { label: current.label } : {}),
                  })
                }
              >
                Open
              </Button>
            ) : (
              onMac &&
              canOpenOnMac(file.name) && (
                <Button
                  size="sm"
                  busy={opening}
                  aria-label={`Open ${file.name} on your Mac`}
                  disabledReason={gone ? "This version is no longer available." : undefined}
                  onClick={() => void openOnMac()}
                >
                  Open
                </Button>
              )
            )}
            <span className="result-file-action" data-state={state}>
              {state === "busy" && <Spinner className="result-file-ring" />}
              <IconButton
                icon={state === "busy" ? "x" : state === "done" ? "check" : "download"}
                label={state === "busy" ? "Cancel download" : `Download ${file.name}`}
                disabledReason={state === "busy" ? undefined : downloadReason}
                onClick={() => {
                  if (state === "busy") downloads.cancel();
                  else void downloads.request(resultId, file, own ? undefined : shown);
                }}
              />
            </span>
          </>
        }
      />
      <Collapse id={panel} open={open} className="deliverable-panel">
        <div ref={body} className="deliverable-body">
          <FilePreview
            state={preview}
            kind={kind}
            name={file.name}
            onRetry={() => setAttempt((n) => n + 1)}
            opens={viewer !== null}
          />
          {(revisable || pair || versions.length > 1) && (
            <div className="deliverable-tools">
              {revisable && (
                <Button
                  variant="quiet"
                  size="sm"
                  icon="compose"
                  disabledReason={gone ? "This version is no longer available." : undefined}
                  onClick={revise}
                >
                  Revise
                </Button>
              )}
              {pair && (
                <Button
                  variant="quiet"
                  size="sm"
                  icon="file-diff"
                  onClick={() => setComparing({ pair, open: true })}
                >
                  Compare v{pair[0].label} → v{pair[1].label}
                </Button>
              )}
              {versions.length > 1 && current && (
                <Select
                  appearance="inline"
                  size="sm"
                  className="deliverable-version"
                  aria-label={`Version of ${file.name}`}
                  value={versionKey(current)}
                  shown={`v${current.label} of ${versions.length}`}
                  items={versions.map((v) => ({
                    value: versionKey(v),
                    label: `v${v.label}`,
                    description: versionDetail(v),
                    ...(v.available ? {} : { disabledReason: "Replaced by a later version" }),
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
