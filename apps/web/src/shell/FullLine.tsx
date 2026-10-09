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

// A clamped line still says everything: a hover names it whole, and a tap or Enter opens it whole
// above the band. What opened stays open while the band moves on to the next line.
export function useFullLine(text: string, content: ReactNode) {
  const { ref, clamped } = useClamped(text);
  const [opened, setOpened] = useState<ReactNode>(null);
  const open = () => setOpened(content);
  const lineProps = clamped
    ? {
        title: text,
        role: "button",
        tabIndex: 0,
        ...triggerProps("dialog", opened !== null),
        onClick: open,
        onKeyDown: (event: KeyboardEvent) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          open();
        },
      }
    : {};
  const full = (
    <FullLine anchor={ref} open={opened !== null} onClose={() => setOpened(null)}>
      {opened}
    </FullLine>
  );
  return { ref, clamped, lineProps, full };
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
