import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../lib/api.ts";
import { Icon } from "../../ui/Icon.tsx";
import { useMediaQuery } from "../../ui/media.ts";
import { SegmentedControl } from "../../ui/SegmentedControl.tsx";
import { CodeLines } from "./CodeLines.tsx";
import { loadsFromWeb } from "./page-refs.ts";
import { ViewerBar, ViewerLoading, ViewerMessage } from "./states.tsx";
import { useText } from "./TextView.tsx";

// A web page dot made, drawn in a frame that runs no script and reaches nothing outside the task:
// the daemon serves it under a policy of no scripts, forms, fonts or connections, pictures and
// stylesheets only from the task's own files, and an empty sandbox makes the frame a page of no
// origin besides. Its source is one switch away.
export function PageView({
  api,
  url,
  sessionId,
  name,
  version,
}: {
  api: ApiClient;
  url: string | null;
  sessionId: string;
  name: string;
  version: number | null;
}) {
  const [shown, setShown] = useState("page");
  const source = useText(api, sessionId, name, version, "start");
  const text = source !== null && source !== "failed" && source.kind === "text" ? source : null;
  const web = text ? loadsFromWeb(text.lines.join("\n")) : false;
  const frame = useRef<HTMLIFrameElement>(null);
  const keys = useMediaQuery("(hover: hover) and (pointer: fine)");
  const [holdsKeys, setHoldsKeys] = useState(false);
  // Keys pressed in the page stay in the page, so the bar says how to have Esc and the arrows back.
  useEffect(() => {
    let tick = 0;
    const check = () => {
      cancelAnimationFrame(tick);
      tick = requestAnimationFrame(() =>
        setHoldsKeys(frame.current !== null && document.activeElement === frame.current),
      );
    };
    window.addEventListener("blur", check);
    window.addEventListener("focus", check);
    return () => {
      cancelAnimationFrame(tick);
      window.removeEventListener("blur", check);
      window.removeEventListener("focus", check);
    };
  }, []);
  return (
    <>
      <ViewerBar
        note={
          holdsKeys && keys ? (
            <span className="viewer-hint">
              <Icon name="keyboard" size={14} />
              Click outside the page to use Esc and the arrow keys
            </span>
          ) : web ? (
            <span className="viewer-hint">
              <Icon name="globe" size={14} />
              Pictures from the web are not loaded
            </span>
          ) : undefined
        }
      >
        <SegmentedControl
          size={28}
          aria-label="Show"
          value={shown}
          items={[
            { value: "page", label: "Page" },
            { value: "source", label: "Source" },
          ]}
          onValueChange={setShown}
        />
      </ViewerBar>
      <div className="viewer-stage viewer-web" hidden={shown !== "page"}>
        {url === null ? (
          <ViewerLoading label="Loading the page" />
        ) : (
          <iframe
            ref={frame}
            className="viewer-frame"
            src={url}
            sandbox=""
            referrerPolicy="no-referrer"
            title={`Page ${name}`}
          />
        )}
      </div>
      {shown === "source" && (
        <div className="viewer-stage viewer-text">
          {source === null ? (
            <ViewerLoading label="Loading the source" />
          ) : text ? (
            <CodeLines lines={text.lines} name={name} wrap label={`Source of ${name}`} />
          ) : (
            <ViewerMessage name={name} title="Can't show the source" />
          )}
        </div>
      )}
    </>
  );
}
