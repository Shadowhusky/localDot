import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type RevealPart, revealText } from "./reveal-text.ts";

const count = (n: number) => n.toLocaleString("en-US");
// Past this many parts, styled markers would take the page seconds to draw, so the value is drawn
// as one plain text with each marker in brackets: still every character, in order.
const MOST_STYLED_PARTS = 20_000;
const MARK = {
  blank: "approval-blank",
  run: "approval-mark",
  lines: "approval-mark",
  hidden: "approval-mark approval-hidden",
} as const;

function draw(parts: RevealPart[]): ReactNode {
  if (parts.length > MOST_STYLED_PARTS)
    return parts
      .map((part) => (part.kind === "text" || part.kind === "blank" ? part.text : `[${part.text}]`))
      .join("");
  return parts.map((part, index) =>
    part.kind === "text" ? (
      part.text
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one immutable value never reorder.
      <span key={index} className={MARK[part.kind]}>
        {part.text}
      </span>
    ),
  );
}

export const ApprovalValue = memo(function ApprovalValue({
  label,
  text,
  total,
}: {
  label: string;
  text: string;
  total?: number;
}) {
  const value = useMemo(() => revealText(text), [text]);
  const drawn = useMemo(() => draw(value.parts), [value]);
  const block = useRef<HTMLPreElement>(null);
  const [scrolls, setScrolls] = useState(false);
  const measure = useCallback(() => {
    const element = block.current;
    if (element) setScrolls(element.scrollHeight > element.clientHeight + 1);
  }, []);
  useLayoutEffect(measure);
  useEffect(() => {
    const element = block.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);
  const facts =
    total === undefined
      ? [
          value.lines > 1 ? `${count(value.lines)} lines` : "",
          value.lines > 1 || text.length > 120 || scrolls ? `${count(text.length)} characters` : "",
          scrolls ? "scroll to read all" : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : `Showing the first ${count(text.length)} of ${count(total)} characters.`;
  return (
    <>
      <pre
        ref={block}
        className="approval-value"
        dir="ltr"
        {...(scrolls ? { tabIndex: 0, role: "region", "aria-label": label } : {})}
      >
        {drawn}
      </pre>
      {facts && <p className="approval-value-facts">{facts}</p>}
      {value.hidden && (
        <p className="approval-value-warning">
          {value.bidi
            ? "Contains hidden characters that change text direction, shown as U+ codes."
            : "Contains hidden characters, shown as U+ codes."}
        </p>
      )}
    </>
  );
});
