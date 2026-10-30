// biome-ignore-all lint/suspicious/noArrayIndexKey: Diff rows have no identity but their position.
import type { FileVersion } from "@localdot/protocol";
import { Fragment, useEffect, useMemo, useState } from "react";
import { count } from "../../copy/format.ts";
import type { ApiClient } from "../../lib/api.ts";
import { useMediaQuery } from "../../ui/media.ts";
import { SegmentedControl } from "../../ui/SegmentedControl.tsx";
import { VisuallyHidden } from "../../ui/VisuallyHidden.tsx";
import { type KeptFile, loadCompare } from "../api.ts";
import { family, highlight, type Span } from "../highlight.ts";
import { Tokens } from "./CodeLines.tsx";
import { type DiffLine, diffCounts, diffLines, sideBySide } from "./diff.ts";
import type { FilePatch } from "./scope.tsx";
import { ViewerBar, ViewerLoading, ViewerMessage, ViewSwitch } from "./states.tsx";
import { useViewChoice, type ViewChoice } from "./views.ts";

// What changed in a file: the task's own edits of a file on the computer, or what a version dot
// handed over changed from the one before.
export type Changes =
  | { kind: "patches"; patches: readonly FilePatch[] }
  | { kind: "versions"; file: KeptFile; from: FileVersion; to: FileVersion };
interface Section {
  title: string;
  lines: DiffLine[];
  truncated: boolean;
}
const OPS = { create: "Created", modify: "Changed", delete: "Deleted" } as const;
const LAYOUTS = [
  { value: "unified", label: "Unified" },
  { value: "split", label: "Side by side" },
];
// Side by side needs room for two columns of code.
const WIDE = "(min-width: 1100px)";
const stat = (lines: readonly DiffLine[]) => {
  const { added, removed } = diffCounts(lines);
  return `+${added} −${removed}`;
};

function patchSections(patches: readonly FilePatch[]): Section[] {
  return patches.flatMap((change) => {
    const diff = diffLines(change.patch);
    if (!diff) return [];
    return [
      {
        title: `${OPS[change.op ?? "modify"]} · ${stat(diff.lines)}`,
        lines: diff.lines,
        truncated: diff.truncated || !!change.truncated,
      },
    ];
  });
}

function useSections(api: ApiClient, changes: Changes): Section[] | "failed" | null {
  const [compared, setCompared] = useState<{ key: string; sections: Section[] | "failed" }>();
  const key =
    changes.kind === "versions"
      ? `${changes.file.sessionId}/${changes.file.name}/${changes.from.sessionId}.${changes.from.version}/${changes.to.sessionId}.${changes.to.version}`
      : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key names the two versions.
  useEffect(() => {
    if (changes.kind !== "versions") return;
    const { file, from, to } = changes;
    const controller = new AbortController();
    loadCompare(
      api,
      file.sessionId,
      file.name,
      { sessionId: from.sessionId, version: from.version as number },
      { sessionId: to.sessionId, version: to.version as number },
      controller.signal,
    ).then(
      (reply) => {
        if (controller.signal.aborted) return;
        const diff = diffLines(reply.patch);
        setCompared({
          key,
          sections: diff
            ? [
                {
                  title: `v${from.label} → v${to.label}`,
                  lines: diff.lines,
                  truncated: reply.truncated || diff.truncated,
                },
              ]
            : [],
        });
      },
      () => !controller.signal.aborted && setCompared({ key, sections: "failed" }),
    );
    return () => controller.abort();
  }, [api, key]);
  const patches = changes.kind === "patches" ? changes.patches : null;
  const own = useMemo(() => (patches ? patchSections(patches) : null), [patches]);
  return own ?? (compared?.key === key ? compared.sections : null);
}

// The changes as one unified diff, or side by side on a wide screen, each line in its language's
// colours. A long patch is shown as far as the activity kept it.
export function ChangesView({
  api,
  name,
  changes,
  choice,
}: {
  api: ApiClient;
  name: string;
  changes: Changes;
  choice?: ViewChoice;
}) {
  const sections = useSections(api, changes);
  const wide = useMediaQuery(WIDE);
  const layout = useViewChoice("diff", LAYOUTS);
  const split = wide && layout.value === "split";
  const bar = (
    <ViewerBar
      note={
        Array.isArray(sections) && sections.length > 0
          ? sections.length === 1
            ? (sections[0] as Section).title
            : count(sections.length, "change", "changes")
          : undefined
      }
      end={
        wide && (
          <SegmentedControl
            size={28}
            aria-label="Layout"
            value={layout.value}
            items={LAYOUTS}
            onValueChange={layout.choose}
          />
        )
      }
    >
      <ViewSwitch choice={choice} />
    </ViewerBar>
  );
  if (sections === null)
    return (
      <>
        {bar}
        <ViewerLoading label="Comparing" />
      </>
    );
  if (sections === "failed" || sections.length === 0)
    return (
      <>
        {bar}
        <ViewerMessage
          name={name}
          title={
            sections === "failed" ? "Couldn't compare the versions" : "No text changes to show"
          }
        />
      </>
    );
  return (
    <>
      {bar}
      <div className="viewer-stage viewer-changes">
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: The changes scroll inside their well, so keyboard users can focus them. */}
        <section className="viewer-diff-scroll" tabIndex={0} aria-label={`Changes to ${name}`}>
          {sections.map((section, i) => (
            <section key={i} className="viewer-diff-section" aria-label={section.title}>
              {sections.length > 1 && <h3 className="viewer-diff-title">{section.title}</h3>}
              {split ? (
                <SplitDiff name={name} lines={section.lines} />
              ) : (
                <UnifiedDiff name={name} lines={section.lines} />
              )}
              {section.truncated && (
                <p className="viewer-diff-note">Shortened to the part the activity kept.</p>
              )}
            </section>
          ))}
        </section>
      </div>
    </>
  );
}

function useTokens(name: string, lines: readonly DiffLine[]): Span[][] {
  return useMemo(
    () =>
      highlight(
        lines.map((line) => (line.kind === "hunk" || line.kind === "note" ? "" : line.text)),
        family(name),
      ),
    [name, lines],
  );
}

const MARKS = { add: "+", remove: "−", same: " " } as const;
const SPOKEN = { add: "Added: ", remove: "Removed: " } as const;
function LineText({ line, spans }: { line: DiffLine; spans: Span[] | undefined }) {
  return (
    <span className="viewer-diff-text">
      {(line.kind === "add" || line.kind === "remove") && (
        <VisuallyHidden>{SPOKEN[line.kind]}</VisuallyHidden>
      )}
      {line.kind === "hunk" || line.kind === "note" || !spans ? (
        line.text
      ) : (
        <Tokens spans={spans} />
      )}
    </span>
  );
}

function UnifiedDiff({ name, lines }: { name: string; lines: readonly DiffLine[] }) {
  const spans = useTokens(name, lines);
  return (
    <div className="viewer-diff" data-layout="unified">
      {lines.map((line, i) =>
        line.kind === "hunk" ? (
          <div key={i} className="viewer-diff-row" data-kind="hunk">
            <span className="viewer-diff-text">{line.text}</span>
          </div>
        ) : (
          <div key={i} className="viewer-diff-row" data-kind={line.kind}>
            <span className="viewer-diff-number" aria-hidden="true">
              {line.old}
            </span>
            <span className="viewer-diff-number" aria-hidden="true">
              {line.new}
            </span>
            <span className="viewer-diff-mark" aria-hidden="true">
              {line.kind === "note" ? "" : MARKS[line.kind]}
            </span>
            <LineText line={line} spans={spans[i]} />
          </div>
        ),
      )}
    </div>
  );
}

function SplitDiff({ name, lines }: { name: string; lines: readonly DiffLine[] }) {
  const spans = useTokens(name, lines);
  const pairs = useMemo(() => sideBySide(lines), [lines]);
  const at = useMemo(() => new Map(lines.map((line, i) => [line, i])), [lines]);
  const cell = (line: DiffLine | undefined, side: "old" | "new") =>
    line ? (
      <div className="viewer-diff-cell" data-kind={line.kind}>
        <span className="viewer-diff-number" aria-hidden="true">
          {side === "old" ? line.old : line.new}
        </span>
        <LineText line={line} spans={spans[at.get(line) ?? -1]} />
      </div>
    ) : (
      <div className="viewer-diff-cell" data-kind="empty" />
    );
  return (
    <div className="viewer-diff" data-layout="split">
      {pairs.map((pair, i) =>
        pair.hunk !== undefined ? (
          <div key={i} className="viewer-diff-row" data-kind="hunk">
            <span className="viewer-diff-text">{pair.hunk}</span>
          </div>
        ) : (
          <Fragment key={i}>
            {cell(pair.left, "old")}
            {cell(pair.right, "new")}
          </Fragment>
        ),
      )}
    </div>
  );
}
