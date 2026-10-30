import { type ReactNode, useMemo } from "react";
import { SafeMarkdown } from "../../agent/SafeMarkdown.tsx";
import { CodeLines } from "./CodeLines.tsx";
import { ViewerBar, ViewSwitch } from "./states.tsx";
import { useViewChoice, type ViewChoice, viewItems } from "./views.ts";

const OWN = viewItems("markdown", {});

// Both views use the same already loaded text. Switching never fetches or executes its contents.
// Without a `choice` of the viewer's, it offers Rendered and Source itself.
export function MarkdownView({
  text,
  name,
  note,
  choice,
  end,
  label,
}: {
  text: string;
  name: string;
  note?: ReactNode;
  choice?: ViewChoice;
  end?: ReactNode;
  label?: string;
}) {
  const own = useViewChoice("markdown", OWN);
  const shown = choice ?? own;
  const lines = useMemo(() => text.split("\n"), [text]);
  return (
    <>
      <ViewerBar note={note} end={end}>
        <ViewSwitch choice={shown} />
      </ViewerBar>
      {shown.value === "source" ? (
        <div className="viewer-stage viewer-text">
          <CodeLines lines={lines} name={name} wrap label={label ?? `Source of ${name}`} />
        </div>
      ) : (
        <div className="viewer-stage viewer-doc">
          <section className="viewer-doc-page" aria-label={`Rendered ${name}`}>
            <SafeMarkdown text={text} shortened="Showing the start of this file." />
          </section>
        </div>
      )}
    </>
  );
}
