import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { t } from "../i18n/index.ts";
import type { ApiClient } from "../lib/api.ts";
import { useLoadAgain } from "../lib/useLoadAgain.ts";
import { ReplayImage } from "../replay/ReplayImage.tsx";
import { focusWithoutScroll } from "../ui/focus.ts";
import { Icon } from "../ui/Icon.tsx";
import { ThumbnailButton } from "../ui/Thumbnail.tsx";
import { downloadResult } from "./file-transfer.ts";
import type { AgentStep } from "./model.ts";
import { type StepResource, useStepPreviewEnvironment } from "./StepPreview.tsx";
import type { WorkStep } from "./thread.ts";

type StepPicture = NonNullable<AgentStep["images"]>[number];
export type WorkPicture =
  | { key: string; label: string; frameId: string }
  | { key: string; label: string; image: StepPicture };

// A run shows this many pictures; past that, the last place opens the rest into a row.
const SHOWN = 3;

// What a run of steps showed: each picture a tool brought back, then the screen as the run left it.
export function workPictures(
  steps: readonly Pick<WorkStep, "key" | "entry" | "title">[],
): WorkPicture[] {
  const pictures: WorkPicture[] = [];
  let screen: WorkPicture | undefined;
  for (const step of steps) {
    const { row } = step.entry;
    if (row.kind !== "step") continue;
    for (const image of row.agent?.images ?? [])
      pictures.push({
        key: `${step.key}/${image.name}`,
        label: t`Preview image: ${image.alt || step.title}`,
        image,
      });
    if (row.computer?.frameId)
      screen = {
        key: `${step.key}/screen`,
        label: t`Preview screenshot: ${step.title}`,
        frameId: row.computer.frameId,
      };
  }
  return screen ? [...pictures, screen] : pictures;
}

// Pictures opened large, moving between them: screenshots, and images as the files a tool saved.
function picturesResource(
  pictures: readonly WorkPicture[],
  index: number,
  sessionId: string,
  bytes: (picture: WorkPicture) => number | undefined,
): StepResource {
  return {
    kind: "file",
    noun: "picture",
    index,
    entries: pictures.map((shown) => {
      if ("frameId" in shown)
        return { sessionId, frameId: shown.frameId, name: t`Step screenshot` };
      const { name, alt } = shown.image;
      return {
        sessionId,
        resultId: name,
        title: alt || t`Image output`,
        file: { name, path: name, bytes: bytes(shown) ?? 0 },
      };
    }),
  };
}

const RunPictures = createContext<readonly WorkPicture[] | null>(null);

// The pictures an image in these steps moves between once it is open.
export function RunPicturesScope({
  steps,
  children,
}: {
  steps: readonly Pick<WorkStep, "key" | "entry" | "title">[];
  children: ReactNode;
}) {
  const pictures = useMemo(() => workPictures(steps), [steps]);
  return <RunPictures.Provider value={pictures}>{children}</RunPictures.Provider>;
}

// One image of a step opened large, among its run's pictures where it has a run.
export function useRunPictureResource(
  image: StepPicture,
  sessionId: string,
  bytes: number | undefined,
): StepResource {
  const run = useContext(RunPictures);
  const isIt = (shown: WorkPicture) => "image" in shown && shown.image.name === image.name;
  const at = run?.findIndex(isIt) ?? -1;
  const pictures = run && at >= 0 ? run : [{ key: image.name, label: "", image }];
  return picturesResource(pictures, Math.max(at, 0), sessionId, (shown) =>
    isIt(shown) ? bytes : undefined,
  );
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

const forget = (api: ApiClient, sessionId: string, name: string) =>
  kept.get(api)?.delete(`${sessionId}/${name}`);

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
  const { attempt, failed } = useLoadAgain(`${sessionId}/${image.name}`);
  // biome-ignore lint/correctness/useExhaustiveDependencies: another attempt loads it again.
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
      () => {
        if (!gone) failed();
      },
    );
    return () => {
      gone = true;
      if (shown) URL.revokeObjectURL(shown);
    };
  }, [api, sessionId, image.name, attempt, failed]);
  return url ? (
    <img
      src={url}
      alt=""
      decoding="async"
      draggable={false}
      onError={() => {
        setUrl(undefined);
        forget(api, sessionId, image.name);
        failed();
      }}
    />
  ) : (
    <span className="replay-image-empty" />
  );
}

// The pictures of a run as small thumbnails under it, each opening large where it is. Past the first
// few the last place opens the rest in place, as one row that scrolls sideways.
export function WorkPictures({
  steps,
  sessionId,
}: {
  steps: readonly WorkStep[];
  // An earlier task's run: the task its pictures were recorded in.
  sessionId?: string;
}) {
  const preview = useStepPreviewEnvironment();
  const bytes = useRef(new Map<string, number>());
  const [near, setNear] = useState(typeof IntersectionObserver === "undefined");
  const [unfolded, setUnfolded] = useState(false);
  // A run's first picture can come long after the run is drawn: the strip is watched once it exists.
  const [strip, setStrip] = useState<HTMLUListElement | null>(null);
  useEffect(() => {
    if (near || !strip) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { root: strip.closest(".ui-scroll-area"), rootMargin: "400px" },
    );
    observer.observe(strip);
    return () => observer.disconnect();
  }, [near, strip]);
  // The button that was pressed has gone: the picture in its place takes the focus.
  useLayoutEffect(() => {
    if (!unfolded) return;
    const next = strip?.querySelectorAll("button")[SHOWN - 1];
    if (next) focusWithoutScroll(next);
  }, [unfolded, strip]);
  const pictures = workPictures(steps);
  if (!preview || !pictures.length) return null;
  const { api, open } = preview;
  const task = sessionId ?? preview.sessionId;
  const more = !unfolded && pictures.length > SHOWN ? pictures.length - (SHOWN - 1) : 0;
  return (
    <ul
      ref={setStrip}
      className="thread-pictures"
      aria-label={t`Pictures`}
      data-strip={unfolded || undefined}
    >
      {pictures.slice(0, more ? SHOWN - 1 : undefined).map((shown, index) => (
        <li key={shown.key}>
          <ThumbnailButton
            className="thread-picture"
            label={shown.label}
            onClick={(event) =>
              open(
                picturesResource(pictures, index, task, (one) => bytes.current.get(one.key)),
                event.currentTarget,
              )
            }
          >
            {near &&
              ("frameId" in shown ? (
                <ReplayImage api={api} sessionId={task} frameId={shown.frameId} near />
              ) : (
                <ImagePicture
                  api={api}
                  sessionId={task}
                  image={shown.image}
                  onBytes={(size) => bytes.current.set(shown.key, size)}
                />
              ))}
            <span className="thread-picture-expand" aria-hidden="true">
              <Icon name="expand" size={14} />
            </span>
          </ThumbnailButton>
        </li>
      ))}
      {more > 0 && (
        <li>
          <ThumbnailButton
            className="thread-picture thread-pictures-more"
            label={more === 1 ? t`Show ${more} more picture` : t`Show ${more} more pictures`}
            onClick={() => setUnfolded(true)}
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
