import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Popover, triggerProps } from "../ui/Popover.tsx";

// Whether the line on show runs past the lines the band gives it, measured as it lays out and
// again whenever its box changes.
export function useClamped(text: string) {
  const ref = useRef<HTMLSpanElement>(null);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !text) {
      setClamped(false);
      return;
    }
    const measure = () => setClamped(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);
  return { ref, clamped };
}

// A clamped line still says everything: a hover names it whole, and a click, a tap or Enter opens it
// whole above the band. Its opener lies over the line, outside the band's live region, so the line
// is announced as plain text. The opener stays while it has focus or its line is open, so the band
// moving on never drops focus; what opened stays open while the band moves on to the next line.
export function useFullLine(text: string, content: ReactNode) {
  const { ref, clamped } = useClamped(text);
  const opener = useRef<HTMLSpanElement>(null);
  const [opened, setOpened] = useState<ReactNode>(null);
  const [focused, setFocused] = useState(false);
  const open = () => setOpened(content);
  const openerProps = {
    title: text,
    role: "button",
    tabIndex: 0,
    "aria-label": "Show the whole line",
    ...triggerProps("dialog", opened !== null),
    onClick: open,
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open();
    },
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
  };
  const opens = clamped || focused || opened !== null;
  const control = opens ? <span ref={opener} className="narration-open" {...openerProps} /> : null;
  const full = (
    <FullLine anchor={opener} open={opened !== null} onClose={() => setOpened(null)}>
      {opened}
    </FullLine>
  );
  return { ref, clamped, opener: control, full };
}

function FullLine({
  anchor,
  open,
  onClose,
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose(): void;
  children: ReactNode;
}) {
  return (
    <Popover
      open={open}
      onClose={onClose}
      anchor={anchor}
      side="top"
      align="start"
      size="lg"
      label="The whole line"
      className="narration-full"
    >
      <p>{children}</p>
    </Popover>
  );
}
