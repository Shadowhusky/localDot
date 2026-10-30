import { textFormat, type ViewerKind } from "@localdot/protocol";
import { useState } from "react";
import type { SegmentItem } from "../../ui/SegmentedControl.tsx";

// The ways one kind of file can be shown, the first of them unless the viewer was last left on
// another for that kind. Rendered only where rendering means something; plain text and code are one
// view, with Changes beside it once the file has an earlier version.
export type ViewName = "rendered" | "source" | "changes" | "pages";
export interface ViewChoice {
  items: readonly SegmentItem[];
  value: string;
  choose(value: string): void;
}
// Each kind of file, and the layout of Changes.
type Bucket = "markdown" | "json" | "html" | "svg" | "table" | "sheet" | "text" | "diff";
const KEY = "localdot.viewer-views.v1";
const LABELS: Record<Bucket, Partial<Record<ViewName, string>>> = {
  markdown: { rendered: "Rendered", source: "Source" },
  json: { rendered: "Tree", source: "Text" },
  html: { rendered: "Page", source: "Source" },
  svg: { rendered: "Picture", source: "Source" },
  table: { rendered: "Table", source: "Source" },
  sheet: { rendered: "Table", pages: "Pages" },
  text: { source: "File" },
  diff: {},
};

export function viewBucket(kind: ViewerKind, name: string): Exclude<Bucket, "diff"> | undefined {
  if (kind === "text" || kind === "details") {
    const format = textFormat(name);
    return format === "markdown" || format === "json" ? format : "text";
  }
  return kind === "html" || kind === "svg" || kind === "table" || kind === "sheet"
    ? kind
    : undefined;
}

function remembered(): Partial<Record<Bucket, string>> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<Record<Bucket, string>>)
      : {};
  } catch {
    return {};
  }
}
function remember(bucket: Bucket, value: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...remembered(), [bucket]: value }));
  } catch {}
}

export function viewItems(
  bucket: Bucket | undefined,
  options: { pages?: boolean; changes?: boolean },
): SegmentItem[] {
  const labels = bucket ? LABELS[bucket] : {};
  const items = (["rendered", "source", "pages"] as const)
    .filter((value) => labels[value] && (value !== "pages" || options.pages))
    .map((value) => ({ value, label: labels[value] as string }));
  return options.changes ? [...items, { value: "changes", label: "Changes" }] : items;
}

// `initial` opens one file on a view without making it the kind's choice.
export function useViewChoice(
  bucket: Bucket | undefined,
  items: readonly SegmentItem[],
  initial?: string,
): ViewChoice {
  const [picked, setPicked] = useState<string | undefined>(initial);
  const values = items.map((item) => item.value);
  const wanted = picked ?? (bucket ? remembered()[bucket] : undefined);
  const value = wanted && values.includes(wanted) ? wanted : (values[0] ?? "source");
  return {
    items,
    value,
    choose: (next) => {
      setPicked(next);
      if (bucket) remember(bucket, next);
    },
  };
}
