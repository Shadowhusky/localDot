import { clsx } from "clsx";
import { type ComponentProps, type Ref, useCallback, useRef } from "react";

// Within this many px of an edge, that edge counts as reached and its fade goes.
const SLACK = 2;

function edges(element: HTMLElement) {
  const below = element.scrollHeight - element.clientHeight - element.scrollTop;
  element.toggleAttribute("data-edge-top", element.scrollTop > SLACK);
  element.toggleAttribute("data-edge-bottom", below > SLACK);
}

export interface ScrollAreaProps extends ComponentProps<"div"> {
  ref?: Ref<HTMLDivElement>;
  // Which edges fade while content lies past them. A sticky header makes its own top edge.
  fade?: "both" | "bottom";
}

// The edge marks are written straight onto the element, so scrolling never re-renders the panel.
export function ScrollArea({ ref, fade = "both", className, onScroll, ...props }: ScrollAreaProps) {
  const observer = useRef<ResizeObserver | null>(null);
  const attach = useCallback(
    (element: HTMLDivElement | null) => {
      observer.current?.disconnect();
      observer.current = null;
      if (typeof ref === "function") ref(element);
      else if (ref) ref.current = element;
      if (!element) return;
      edges(element);
      if (typeof ResizeObserver === "undefined") return;
      observer.current = new ResizeObserver(() => edges(element));
      observer.current.observe(element);
      if (element.firstElementChild) observer.current.observe(element.firstElementChild);
    },
    [ref],
  );
  return (
    <div
      {...props}
      ref={attach}
      className={clsx("ui-scroll-area", className)}
      data-fade={fade}
      onScroll={(event) => {
        edges(event.currentTarget);
        onScroll?.(event);
      }}
    />
  );
}
