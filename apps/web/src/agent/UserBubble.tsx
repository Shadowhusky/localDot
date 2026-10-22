import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../ui/Icon.tsx";
import { fileName } from "./attachments.ts";
import { FileName } from "./ResultFiles.tsx";

// The files a message carried, along the top of its bubble on one line that scrolls sideways.
function SentFiles({ paths }: { paths: readonly string[] }) {
  const list = useRef<HTMLUListElement>(null);
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const measure = () => setScrolls(element.scrollWidth > element.clientWidth + 1);
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <ul
      ref={list}
      className="thread-bubble-files"
      aria-label="Attached files"
      // A row wider than the bubble scrolls, so the keys can reach it to scroll it.
      tabIndex={scrolls ? 0 : undefined}
    >
      {paths.map((path) => (
        <li key={path} className="file-chip">
          <Icon name="file" size={12} className="file-chip-icon" />
          <FileName name={fileName(path)} />
        </li>
      ))}
    </ul>
  );
}

// Your message as the thread draws it, sent or on its way: the files it carried, then its words,
// with `lead` (its copy button, or a spinner while it is sent) beside the bubble.
export function UserBubble({
  text,
  files,
  lead,
}: {
  text: string;
  files: readonly string[];
  lead: ReactNode;
}) {
  return (
    <div className="thread-said">
      {lead}
      <div className="thread-bubble">
        {files.length > 0 && <SentFiles paths={files} />}
        <p className="thread-bubble-text">{text}</p>
      </div>
    </div>
  );
}
