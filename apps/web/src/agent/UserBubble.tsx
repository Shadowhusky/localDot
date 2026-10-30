import { isComputerPath, viewerKind } from "@localdot/protocol";
import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useThumbnail } from "../deliverables/useThumbnail.ts";
import type { ComputerEntry } from "../deliverables/viewer/scope.tsx";
import type { ApiClient } from "../lib/api.ts";
import { HitButton } from "../ui/HitButton.tsx";
import { Icon } from "../ui/Icon.tsx";
import { fileName } from "./attachments.ts";
import { FileName } from "./ResultFiles.tsx";
import { useStepPreviewEnvironment } from "./StepPreview.tsx";

// One file a message carried: pressing it opens it in the viewer, and a picture shows itself.
function SentFile({
  path,
  entry,
  api,
  onOpen,
}: {
  path: string;
  entry?: ComputerEntry;
  api?: ApiClient;
  onOpen?(trigger: HTMLButtonElement): void;
}) {
  const name = fileName(path);
  const chip = useRef<HTMLLIElement>(null);
  const picture = useThumbnail(
    api ?? null,
    onOpen && viewerKind(name) === "picture" ? entry : undefined,
    chip,
  );
  return (
    <li ref={chip} className="file-chip" data-opens={onOpen ? "" : undefined}>
      {picture ? (
        <img className="file-chip-thumb" src={picture} alt="" decoding="async" />
      ) : (
        <Icon name="file" size={12} className="file-chip-icon" />
      )}
      <FileName name={name} />
      {onOpen && <HitButton className="file-chip-hit" label={`Open ${name}`} onClick={onOpen} />}
    </li>
  );
}

// The files a message carried, along the top of its bubble on one line that scrolls sideways. With
// the task it was sent to, each opens in the viewer, moving between the message's files.
function SentFiles({ paths, sessionId }: { paths: readonly string[]; sessionId?: string }) {
  const preview = useStepPreviewEnvironment();
  const entries = useMemo(
    () =>
      sessionId
        ? paths.filter(isComputerPath).map((path): ComputerEntry => ({ sessionId, path }))
        : [],
    [paths, sessionId],
  );
  const list = useRef<HTMLUListElement>(null);
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const measure = () => setScrolls(element.scrollWidth > element.clientWidth + 1);
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <ul
      ref={list}
      className="thread-bubble-files"
      aria-label="Attached files"
      // A row wider than the bubble scrolls, so the keys can reach it to scroll it.
      tabIndex={scrolls ? 0 : undefined}
    >
      {paths.map((path) => {
        const index = entries.findIndex((entry) => entry.path === path);
        return (
          <SentFile
            key={path}
            path={path}
            entry={entries[index]}
            api={preview?.api}
            onOpen={
              preview && index >= 0
                ? (trigger) => preview.open({ kind: "files", entries, index }, trigger)
                : undefined
            }
          />
        );
      })}
    </ul>
  );
}

// Your message as the thread draws it, sent or on its way: the files it carried, then its words,
// with `lead` (its copy button, or a spinner while it is sent) beside the bubble. Once sent, its
// task (`sessionId`) lets its files open.
export function UserBubble({
  text,
  files,
  lead,
  sessionId,
}: {
  text: string;
  files: readonly string[];
  lead: ReactNode;
  sessionId?: string;
}) {
  return (
    <div className="thread-said">
      {lead}
      <div className="thread-bubble">
        {files.length > 0 && <SentFiles paths={files} sessionId={sessionId} />}
        <p className="thread-bubble-text">{text}</p>
      </div>
    </div>
  );
}
