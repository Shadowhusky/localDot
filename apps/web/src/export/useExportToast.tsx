import { useEffect, useRef } from "react";
import { Progress } from "../ui/Progress.tsx";
import { dismissToast, showToast } from "../ui/Toast.tsx";
import type { ToastOptions } from "../ui/toasts.ts";
import { CANCELLED_NOTE, type ExportJob, type ExportJobState, useExportJob } from "./job.ts";

const TOAST = "export";

// The percentage counts up in the toast without asking it to change, so it is announced once.
function ExportCount({ job }: { job: ExportJob }) {
  const { done, total } = useExportJob(job);
  const percent = total ? Math.floor((Math.min(done, total) / total) * 100) : null;
  return (
    <span className="export-toast">
      <Progress
        variant="ring"
        size={16}
        label="Export progress"
        value={total ? done : undefined}
        max={total || 1}
      />
      <span>Exporting…</span>
      <span className="export-toast-percent num" aria-hidden={percent === null}>
        {percent === null ? "" : `${percent}%`}
      </span>
    </span>
  );
}

// What the island's toast says of an export, wherever the person is in the app: while it is made,
// when it is ready to save, and when it fails. A cancelled one says nothing.
export function exportNotice(
  state: Pick<ExportJobState, "phase" | "note">,
): (Omit<ToastOptions, "live" | "action"> & { live?: true; save?: true }) | null {
  switch (state.phase) {
    case "exporting":
      return { id: TOAST, title: "Exporting…", live: true };
    case "ready":
      return { id: TOAST, tone: "success", title: "Your video is ready", save: true };
    case "saved":
      return { id: TOAST, tone: "success", title: "Video saved" };
    case "options":
      return state.note && state.note !== CANCELLED_NOTE
        ? { id: TOAST, tone: "danger", title: "Couldn't make the video", description: state.note }
        : null;
    default:
      return null;
  }
}

export function useExportToast(job: ExportJob): void {
  const state = useExportJob(job);
  const notice = exportNotice(state);
  const key = notice ? JSON.stringify(notice) : null;
  const shown = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the notice is rebuilt each render; its words are what change
  useEffect(() => {
    if (!notice) {
      if (shown.current) dismissToast(TOAST);
      shown.current = null;
      return;
    }
    shown.current = key;
    const { live, save, ...words } = notice;
    showToast({
      ...words,
      ...(live ? { live: <ExportCount job={job} /> } : {}),
      ...(save ? { action: { label: "Save", onAction: () => job.save() } } : {}),
    });
  }, [key, job]);
}
