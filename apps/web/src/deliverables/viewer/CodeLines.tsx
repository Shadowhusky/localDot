// biome-ignore-all lint/suspicious/noArrayIndexKey: A line has no identity but its number.
// biome-ignore-all lint/a11y/noNoninteractiveTabindex: The text scrolls inside its well, so keyboard users can focus it.
import { type CSSProperties, memo, useEffect, useMemo, useRef, useState } from "react";
import { family, highlight, type Span } from "../highlight.ts";

const CHUNK = 200;
const TONES = {
  keyword: "tok-k",
  string: "tok-s",
  number: "tok-n",
  comment: "tok-c",
  tag: "tok-k",
  attribute: "tok-n",
} as const;

// Text as numbered lines in the code well, coloured by the file's language. Lines are drawn a few
// hundred at a time as they come near the view, so a long file opens at once.
export function CodeLines({
  lines,
  name,
  wrap,
  numbered = true,
  label,
}: {
  lines: readonly string[];
  // Names the language by its extension.
  name: string;
  wrap: boolean;
  numbered?: boolean;
  label: string;
}) {
  const spans = useMemo(() => highlight(lines, family(name)), [lines, name]);
  const chunks = useMemo(() => {
    const out: Span[][][] = [];
    for (let at = 0; at < spans.length; at += CHUNK) out.push(spans.slice(at, at + CHUNK));
    return out;
  }, [spans]);
  const digits = String(lines.length).length;
  return (
    <section
      className="viewer-code"
      aria-label={label}
      tabIndex={0}
      data-wrap={wrap || undefined}
      data-numbered={numbered || undefined}
      style={{ "--_digits": digits } as CSSProperties}
    >
      {chunks.map((chunk, i) => (
        <Chunk key={i} first={i * CHUNK + 1} lines={chunk} />
      ))}
    </section>
  );
}

const Chunk = memo(function Chunk({ first, lines }: { first: number; lines: Span[][] }) {
  const host = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(first === 1);
  useEffect(() => {
    if (shown) return;
    const element = host.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        setShown(true);
      },
      { rootMargin: "800px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [shown]);
  return (
    <div
      ref={host}
      className="viewer-code-chunk"
      data-pending={shown ? undefined : ""}
      style={{ "--_lines": lines.length } as CSSProperties}
    >
      {shown &&
        lines.map((line, i) => (
          <div key={i} className="viewer-code-line">
            <span className="viewer-code-number" aria-hidden="true">
              {first + i}
            </span>
            <span className="viewer-code-text">
              {line.length === 0
                ? "\n"
                : line.map((span, j) =>
                    span.tone ? (
                      <span key={j} className={TONES[span.tone]}>
                        {span.text}
                      </span>
                    ) : (
                      span.text
                    ),
                  )}
            </span>
          </div>
        ))}
    </div>
  );
});
