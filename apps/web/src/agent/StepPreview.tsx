import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FileViewer } from "../deliverables/viewer/FileViewer.tsx";
import { MarkdownView } from "../deliverables/viewer/MarkdownView.tsx";
import { PictureView } from "../deliverables/viewer/PictureView.tsx";
import type { ViewerEntry } from "../deliverables/viewer/scope.tsx";
import { ViewerLoading, ViewerMessage } from "../deliverables/viewer/states.tsx";
import type { ApiClient } from "../lib/api.ts";
import { releaseThumbnail, thumbnailUrl } from "../session/thumbnails.ts";
import { ErrorBoundary } from "../ui/ErrorBoundary.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import type { AgentResult } from "./model.ts";
import { OutputCopy } from "./OutputCopy.tsx";
import { useResultDownloads } from "./ResultFiles.tsx";
import "../ui/step-preview.css";

export type StepResource =
  | { kind: "file"; entry: ViewerEntry; label?: string }
  | { kind: "text"; name: string; text: string; markdown?: boolean }
  | { kind: "frame"; name: string; sessionId: string; frameId: string };
const Context = createContext<{
  api: ApiClient | null;
  sessionId: string | null;
  scale: number;
  open(resource: StepResource, trigger: HTMLElement): void;
  files: readonly ViewerEntry[];
} | null>(null);
export function useStepPreviewEnvironment() {
  const context = useContext(Context);
  return context?.api && context.sessionId
    ? { ...context, api: context.api, sessionId: context.sessionId }
    : null;
}
const LARGE = ["large"] as const;

// Lives outside the virtual rows: scrolling or collapsing the source step cannot close a preview.
// Nothing is fetched or parsed for the viewer until the user opens it.
export function StepPreviewScope({
  api,
  sessionId,
  results,
  scale = 1,
  children,
}: {
  api: ApiClient | null;
  sessionId: string | null;
  results: readonly AgentResult[];
  // Device px to a CSS px on the computer's display, which recorded targets are measured in.
  scale?: number;
  children: ReactNode;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  const files = useMemo(
    () =>
      !sessionId
        ? []
        : results
            .filter((result) => !result.sessionId || result.sessionId === sessionId)
            .flatMap((result) =>
              result.files.map((file) => ({
                file,
                resultId: result.id,
                sessionId: result.sessionId ?? sessionId,
              })),
            ),
    [results, sessionId],
  );
  const [stored, setSelection] = useState<{
    owner: string | null;
    resource: StepResource;
    anchor: Element | null;
    open: boolean;
  } | null>(null);
  const selection = stored?.owner === sessionId ? stored : null;
  const [width, setWidth] = useState<number>();
  useEffect(() => {
    if (!selection?.open) return;
    const anchor = selection.anchor;
    const measure = () => {
      const room = (anchor?.isConnected ? anchor.getBoundingClientRect().left : 0) - 16;
      // On stacked layouts use the normal accessible full-height sheet instead.
      setWidth(window.innerWidth >= 1100 && room >= 360 ? Math.min(1120, room) : undefined);
    };
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    if (anchor) observer?.observe(anchor);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [selection]);
  const resource = selection?.resource;
  const entry = resource?.kind === "file" ? resource.entry : undefined;
  const downloadable = useMemo<AgentResult[]>(
    () =>
      entry
        ? [
            {
              id: entry.resultId,
              sessionId: entry.sessionId,
              summary: "",
              files: [entry.file],
            },
          ]
        : [],
    [entry],
  );
  const downloads = useResultDownloads(api, entry?.sessionId ?? null, downloadable);
  const close = () => setSelection((was) => was && { ...was, open: false });
  const open = useCallback(
    (next: StepResource, trigger: HTMLElement) => {
      returnFocus.current = trigger;
      const anchor = trigger.closest(".activity-rail, .rail-chat");
      const room = (anchor?.getBoundingClientRect().left ?? 0) - 16;
      setWidth(window.innerWidth >= 1100 && room >= 360 ? Math.min(1120, room) : undefined);
      setSelection({ owner: sessionId, resource: next, anchor, open: true });
    },
    [sessionId],
  );
  const context = useMemo(
    () => ({ files, api, sessionId, scale, open }),
    [files, api, sessionId, scale, open],
  );
  return (
    <Context.Provider value={context}>
      {children}
      {selection && api && (
        <ErrorBoundary floating key={resource?.kind}>
          {entry ? (
            <FileViewer
              api={api}
              entries={[entry]}
              displayName={resource?.kind === "file" ? resource.label : undefined}
              index={0}
              open={selection.open}
              downloads={downloads}
              onMac={false}
              onIndex={() => {}}
              onClose={close}
              previewWidth={width}
              returnFocus={returnFocus}
            />
          ) : (
            resource &&
            resource.kind !== "file" && (
              <Sheet
                open={selection.open}
                onClose={close}
                returnFocus={returnFocus}
                title={resource.name}
                description={
                  resource.kind === "frame" ? "Recorded screenshot" : "Recorded step output"
                }
                className="file-viewer step-preview-sheet"
                style={width ? { left: 8, right: "auto", width } : undefined}
                size="wide"
                modal={!width}
                detents={LARGE}
                flush
                footer={
                  resource.kind === "text" ? (
                    <OutputCopy text={resource.text} label="Copy output" />
                  ) : undefined
                }
              >
                <div className="viewer">
                  <div className="viewer-pane">
                    {resource.kind === "frame" ? (
                      <FramePreview api={api} resource={resource} />
                    ) : (
                      <MarkdownView
                        key={resource.name + resource.text}
                        text={resource.text}
                        name={resource.name}
                        initialMode={resource.markdown ? "rendered" : "source"}
                        label="Step output preview"
                      />
                    )}
                  </div>
                </div>
              </Sheet>
            )
          )}
        </ErrorBoundary>
      )}
    </Context.Provider>
  );
}

export function StepPreviewButton({ resource, label }: { resource: StepResource; label: string }) {
  const viewer = useContext(Context);
  if (!viewer?.api || !viewer.sessionId) return null;
  return (
    <IconButton
      icon="expand"
      label={label}
      size={32}
      variant="glass"
      className="step-preview-button"
      onClick={(event) => {
        event.stopPropagation();
        viewer.open(resource, event.currentTarget);
      }}
    />
  );
}

// Match only files already handed over by this task. Text that happens to look like a path or URL
// never authorizes a new file read, remote request or conversion. Require whole path/name tokens.
export function referencedFiles(text: string, files: readonly ViewerEntry[]): ViewerEntry[] {
  const seen = new Set<string>();
  return [...files]
    .reverse()
    .filter((entry) => {
      const key = `${entry.sessionId}/${entry.file.name}`;
      if (seen.has(key)) return false;
      const matches = [entry.file.path, entry.file.name].some((path) => {
        if (!path) return false;
        let at = text.indexOf(path);
        while (at >= 0) {
          const before = text[at - 1] ?? "";
          const after = text[at + path.length] ?? "";
          if ((!before || /[\s`"'([=]/.test(before)) && (!after || /[\s`"')\],;:]/.test(after)))
            return true;
          at = text.indexOf(path, at + path.length);
        }
        return false;
      });
      if (matches) seen.add(key);
      return matches;
    })
    .slice(0, 20);
}

export function StepFileResources({ text }: { text: string }) {
  const viewer = useContext(Context);
  const files = useMemo(() => referencedFiles(text, viewer?.files ?? []), [text, viewer?.files]);
  if (!files.length) return null;
  return (
    <section className="step-file-resources" aria-label="Output files">
      {files.map((entry) => (
        <div
          className="step-file-resource step-preview-resource"
          key={`${entry.sessionId}/${entry.file.name}`}
        >
          <span>{entry.file.name}</span>
          <StepPreviewButton
            label={`Preview ${entry.file.name}`}
            resource={{ kind: "file", entry }}
          />
        </div>
      ))}
    </section>
  );
}

function FramePreview({
  api,
  resource,
}: {
  api: ApiClient;
  resource: Extract<StepResource, { kind: "frame" }>;
}) {
  const { sessionId, frameId, name } = resource;
  const key = `${sessionId}/${frameId}`;
  const [state, setState] = useState<{ key: string; url?: string }>();
  useEffect(() => {
    let disposed = false;
    thumbnailUrl(api, sessionId, frameId).then(
      (url) => {
        if (!disposed) setState({ key, url });
      },
      () => {
        if (!disposed) setState({ key });
      },
    );
    return () => {
      disposed = true;
      releaseThumbnail(api, sessionId, frameId);
    };
  }, [api, sessionId, frameId, key]);
  if (state?.key !== key) return <ViewerLoading label="Loading screenshot" />;
  return state.url ? (
    <PictureView key={key} src={state.url} name={name} />
  ) : (
    <ViewerMessage name={name} title="Screenshot unavailable" />
  );
}
