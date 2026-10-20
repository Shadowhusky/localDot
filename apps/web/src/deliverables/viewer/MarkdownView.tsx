import { type ReactNode, useMemo, useState } from "react";
import { SafeMarkdown } from "../../agent/SafeMarkdown.tsx";
import { SegmentedControl } from "../../ui/SegmentedControl.tsx";
import { CodeLines } from "./CodeLines.tsx";
import { ViewerBar } from "./states.tsx";

// Both views use the same already loaded text. Switching never fetches or executes its contents.
export function MarkdownView({
  text,
  name,
  note,
  initialMode = "rendered",
  label,
}: {
  text: string;
  name: string;
  note?: ReactNode;
  initialMode?: "rendered" | "source";
  label?: string;
}) {
  const [mode, setMode] = useState<string>(initialMode);
  const lines = useMemo(() => text.split("\n"), [text]);
  return (
    <>
      <ViewerBar note={note}>
        <SegmentedControl
          size={28}
          aria-label="Markdown view"
          value={mode}
          items={[
            { value: "rendered", label: "Rendered" },
            { value: "source", label: "Source" },
          ]}
          onValueChange={setMode}
        />
      </ViewerBar>
      {mode === "rendered" ? (
        <div className="viewer-stage viewer-doc">
          <section className="viewer-doc-page" aria-label={`Rendered ${name}`}>
            <SafeMarkdown text={text} shortened="Showing the start of this file." />
          </section>
        </div>
      ) : (
        <div className="viewer-stage viewer-text">
          <CodeLines lines={lines} name={name} wrap label={label ?? `Source of ${name}`} />
        </div>
      )}
    </>
  );
}
