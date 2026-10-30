import type { ComputerSize, ComputerSizeView } from "@localdot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { Group, GroupHead, GroupNote } from "../ui/Group.tsx";
import { SliderKey, StepSlider } from "../ui/StepSlider.tsx";
import {
  browserLine,
  cpuCount,
  cpuSlider,
  dockerTip,
  gigabytes,
  memorySlider,
  readSize,
  recommendedSize,
  saveSize,
  sizeProblem,
} from "./computer-size.ts";

const GIB = 1024 ** 3;
// While Settings is open, the computer's use is read again this often.
const REFRESH_MS = 5000;
// As Settings' own autosave: a drag saves once it pauses.
const SAVE_AFTER_MS = 500;

// What Docker holds for this dot's computer, read once, or again every `everyMs` while mounted.
// Undefined while it loads, null when Docker isn't answering. A view a save answered with wins
// over a reading begun before it.
export function useComputerSize(api: ApiClient | null, everyMs?: number) {
  const [view, setView] = useState<ComputerSizeView | null | undefined>(undefined);
  const latest = useRef(0);
  const saved = useCallback((next: ComputerSizeView) => {
    latest.current += 1;
    setView(next);
  }, []);
  useEffect(() => {
    if (!api) return;
    let busy: AbortController | null = null;
    const load = () => {
      if (busy) return;
      const controller = new AbortController();
      const reading = ++latest.current;
      busy = controller;
      readSize(api, controller.signal)
        .then((next) => {
          if (reading === latest.current) setView(next);
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted && error instanceof ApiError && error.status === 503)
            setView(null);
        })
        .finally(() => {
          if (busy === controller) busy = null;
        });
    };
    load();
    const timer = everyMs ? window.setInterval(load, everyMs) : 0;
    return () => {
      window.clearInterval(timer);
      busy?.abort();
    };
  }, [api, everyMs]);
  return [view, saved] as const;
}

// Docker can't hold even the smallest computer beside the other dots: plainly, and where to fix it.
export function tooSmall(view: ComputerSizeView): string | null {
  if (recommendedSize(view)) return null;
  return view.max.memoryBytes < view.min.memoryBytes
    ? `Docker can't hold dot's computer beside what else runs: it needs at least ${gigabytes(view.min.memoryBytes)}. ${dockerTip(view.docker, "memory")}`
    : `Docker can't give dot's computer the ${cpuCount(view.min.cpus)} it needs beside the other dots. ${dockerTip(view.docker, "cpus")}`;
}

export function SizeSlider({
  kind,
  view,
  size,
  onChange,
}: {
  kind: "memory" | "cpus";
  view: ComputerSizeView;
  size: ComputerSize;
  onChange(size: ComputerSize): void;
}) {
  const memory = kind === "memory";
  const { legend, ...model } = memory
    ? memorySlider(view, size.memoryBytes)
    : cpuSlider(view, size.cpus);
  return (
    <StepSlider
      {...model}
      label={memory ? "Memory" : "CPUs"}
      valueText={memory ? (value) => gigabytes(value * GIB) : cpuCount}
      onValueChange={(value) =>
        onChange(
          memory ? { ...size, memoryBytes: Math.round(value * GIB) } : { ...size, cpus: value },
        )
      }
    >
      {legend.map(({ tone, text }) => (
        <SliderKey key={tone} tone={tone}>
          {text}
        </SliderKey>
      ))}
    </StepSlider>
  );
}

// Settings › Your computer: how much of Docker this dot's computer may take, saved as it is set.
export function ComputerSizeSettings({ api }: { api: ApiClient }) {
  const [view, setView] = useComputerSize(api, REFRESH_MS);
  const [draft, setDraft] = useState<ComputerSize | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const unsaved = useRef<ComputerSize | null>(null);

  useEffect(() => {
    if (!draft) return;
    const timer = window.setTimeout(() => {
      unsaved.current = null;
      saveSize(api, draft)
        .then((next) => {
          setView(next);
          setProblem(null);
        })
        .catch((error: unknown) => setProblem(sizeProblem(error)))
        .finally(() => setDraft((now) => (now === draft ? null : now)));
    }, SAVE_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [api, draft, setView]);
  // Closing Settings mid-drag still saves where the drag ended.
  useEffect(
    () => () => {
      if (unsaved.current) void saveSize(api, unsaved.current).catch(() => {});
    },
    [api],
  );

  if (view === undefined) return null;
  if (view === null)
    return (
      <div>
        <GroupHead title="Memory and CPUs" />
        <GroupNote>Docker isn't answering, so the computer's size can't be shown now.</GroupNote>
      </div>
    );
  const size = draft ?? view.size;
  const change = (next: ComputerSize) => {
    unsaved.current = next;
    setProblem(null);
    setDraft(next);
  };
  return (
    <div>
      <GroupHead title="Memory and CPUs" />
      <Group>
        <div className="ui-group-row settings-size-row">
          <SizeSlider kind="memory" view={view} size={size} onChange={change} />
        </div>
        <div className="ui-group-row settings-size-row">
          <SizeSlider kind="cpus" view={view} size={size} onChange={change} />
        </div>
      </Group>
      <GroupNote>
        {problem ? (
          <span className="settings-computer-error" role="alert">
            {problem}
          </span>
        ) : (
          <span role="status">
            {tooSmall(view) ??
              (view.pending && !draft
                ? "Saved. The computer is using more memory than that right now, so the smaller size applies when it next starts."
                : `${browserLine(size)} Changes apply at once.`)}
          </span>
        )}
      </GroupNote>
    </div>
  );
}
