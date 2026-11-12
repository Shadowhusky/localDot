import type { HostExport } from "@localdot/protocol";
import { t } from "../i18n/index.ts";
import { clockLabel, dayLabel, timeLabel } from "../replay/replay-view.ts";
import type { GlyphState } from "../ui/StatusGlyph.tsx";
import { fileSize, videoLength } from "./export-plan.ts";

export function exportPercent(record: Pick<HostExport, "done" | "total">): number {
  return record.total ? Math.floor((Math.min(record.done, record.total) / record.total) * 100) : 0;
}

export function exportRunning(record: Pick<HostExport, "phase">): boolean {
  return record.phase === "queued" || record.phase === "making";
}

// What a row says under the file's name.
export function exportMeta(record: HostExport, now: Date): string {
  switch (record.phase) {
    case "queued":
      return t`Waiting to start`;
    case "making":
      if (!record.total) return t`Getting the recording ready`;
      return `${exportPercent(record)}% · ${record.leftMs === null ? t`working out the time left` : t`about ${timeLabel(record.leftMs)} left`}`;
    case "done": {
      const made = new Date(record.createdAt).toISOString();
      const length = record.durationS === null ? "" : ` · ${videoLength(record.durationS)}`;
      return `${fileSize(record.bytes)}${length} · ${dayLabel(made, now)} ${clockLabel(made)}`;
    }
    case "failed":
      return record.error ?? t`This video couldn't be made.`;
  }
}

export function exportGlyph(record: Pick<HostExport, "phase">): {
  state: GlyphState;
  label: string;
} {
  switch (record.phase) {
    case "queued":
      return { state: "todo", label: t`Waiting` };
    case "making":
      return { state: "doing", label: t`Making` };
    case "done":
      return { state: "done", label: t`Ready` };
    case "failed":
      return { state: "failed", label: t`Failed` };
  }
}
