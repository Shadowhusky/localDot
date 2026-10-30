import { useEffect, useRef, useState } from "react";
import { count } from "../copy/format.ts";
import type { ApiClient } from "../lib/api.ts";
import { ReplayImage } from "../replay/ReplayImage.tsx";
import { ThumbnailButton } from "../ui/Thumbnail.tsx";
import { downloadResult } from "./file-transfer.ts";
import type { AgentStep } from "./model.ts";
import { type StepResource, useStepPreviewEnvironment } from "./StepPreview.tsx";
import type { WorkStep } from "./thread.ts";

type StepPicture = NonNullable<AgentStep["images"]>[number];
export type WorkPicture =
  | { key: string; label: string; frameId: string }
  | { key: string; label: string; image: StepPicture };

// A run shows this many pictures; past that, the last place says how many more its steps hold.
const SHOWN = 3;

// What a run of steps showed: each picture a tool brought back, then the screen as the run left it.
export function workPictures(steps: readonly WorkStep[]): WorkPicture[] {
  const pictures: WorkPicture[] = [];
  let screen: WorkPicture | undefined;
  for (const step of steps) {
    const { row } = step.entry;
    if (row.kind !== "step") continue;
    for (const image of row.agent?.images ?? [])
      pictures.push({
        key: `${step.key}/${image.name}`,
        label: `Preview image: ${image.alt || step.title}`,
        image,
      });
    if (row.computer?.frameId)
      screen = {
        key: `${step.key}/screen`,
        label: `Preview screenshot: ${step.title}`,
        frameId: row.computer.frameId,
      };
  }
  return screen ? [...pictures, screen] : pictures;
}

// A picture opened large: a screenshot, or an image as the file a tool saved.
function resourceOf(
  shown: WorkPicture,
  sessionId: string,
  bytes: ReadonlyMap<string, number>,
): StepResource {
  if ("frameId" in shown)
    return { kind: "frame", name: "Step screenshot", sessionId, frameId: shown.frameId };
  const { name, alt } = shown.image;
  return {
    kind: "file",
    label: alt || "Image output",
    entry: {
      sessionId,
      resultId: name,
      file: { name, path: name, bytes: bytes.get(shown.key) ?? 0 },
    },
  };
}

// Pictures downloaded for the thread, newest last; a few stay for rows that mount again.
const KEPT = 32;
const kept = new WeakMap<ApiClient, Map<string, Promise<Blob>>>();
function picture(api: ApiClient, sessionId: string, name: string): Promise<Blob> {
  let blobs = kept.get(api);
  if (!blobs) {
    blobs = new Map();
    kept.set(api, blobs);
  }
  const key = `${sessionId}/${name}`;
  const held = blobs.get(key);
  if (held) {
    blobs.delete(key);
    blobs.set(key, held);
    return held;
  }
  const loading = downloadResult(api, sessionId, name, AbortSignal.timeout(15_000));
  blobs.set(key, loading);
  loading.catch(() => blobs.delete(key));
  for (const old of blobs.keys()) {
    if (blobs.size <= KEPT) break;
    blobs.delete(old);
  }
  return loading;
}

function ImagePicture({
  api,
  sessionId,
  image,
  onBytes,
}: {
  api: ApiClient;
  sessionId: string;
  image: StepPicture;
  onBytes(bytes: number): void;
}) {
  const [url, setUrl] = useState<string>();
  const told = useRef(onBytes);
  told.current = onBytes;
  useEffect(() => {
    let shown: string | undefined;
    let gone = false;
    picture(api, sessionId, image.name).then(
      (blob) => {
        if (gone) return;
        shown = URL.createObjectURL(blob.slice(0, blob.size, "image/jpeg"));
        told.current(blob.size);
        setUrl(shown);
      },
      () => {},
    );
    return () => {
      gone = true;
      if (shown) URL.revokeObjectURL(shown);
    };
  }, [api, sessionId, image.name]);
  return url ? (
    <img src={url} alt="" decoding="async" draggable={false} />
  ) : (
    <span className="replay-image-empty" />
  );
}

// The pictures of a run as small thumbnails under it, each opening large where it is.
export function WorkPictures({
  steps,
  sessionId,
  onMore,
}: {
  steps: readonly WorkStep[];
  // An earlier task's run: the task its pictures were recorded in.
  sessionId?: string;
  // Shows the run's steps, where the pictures past the first few are.
  onMore(): void;
}) {
  const preview = useStepPreviewEnvironment();
  const bytes = useRef(new Map<string, number>());
  const [near, setNear] = useState(typeof IntersectionObserver === "undefined");
  const strip = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (near || !strip.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: "400px" },
    );
    observer.observe(strip.current);
    return () => observer.disconnect();
  }, [near]);
  const pictures = workPictures(steps);
  if (!preview || !pictures.length) return null;
  const { api, open } = preview;
  const task = sessionId ?? preview.sessionId;
  const more = pictures.length > SHOWN ? pictures.length - (SHOWN - 1) : 0;
  return (
    <ul ref={strip} className="thread-pictures" aria-label="Pictures">
      {pictures.slice(0, more ? SHOWN - 1 : SHOWN).map((shown) => (
        <li key={shown.key}>
          <ThumbnailButton
            className="thread-picture"
            label={shown.label}
            onClick={(event) => open(resourceOf(shown, task, bytes.current), event.currentTarget)}
          >
            {near &&
              ("frameId" in shown ? (
                <ReplayImage api={api} sessionId={task} frameId={shown.frameId} />
              ) : (
                <ImagePicture
                  api={api}
                  sessionId={task}
                  image={shown.image}
                  onBytes={(size) => bytes.current.set(shown.key, size)}
                />
              ))}
          </ThumbnailButton>
        </li>
      ))}
      {more > 0 && (
        <li>
          <ThumbnailButton
            className="thread-picture thread-pictures-more"
            label={`Show ${count(more, "more picture", "more pictures")} in the steps`}
            onClick={onMore}
          >
            <span className="num" aria-hidden="true">
              +{more}
            </span>
          </ThumbnailButton>
        </li>
      )}
    </ul>
  );
}
