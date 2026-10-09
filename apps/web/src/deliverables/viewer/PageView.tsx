import { useState } from "react";
import type { ApiClient } from "../../lib/api.ts";
import { Icon } from "../../ui/Icon.tsx";
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
  return (
    <>
      <ViewerBar
        note={
          web ? (
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
