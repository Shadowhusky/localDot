import { useState } from "react";
import { ViewerMessage } from "./states.tsx";

// Sound or video with the browser's own controls, streamed from the file. A video shows its first
// moments as its poster.
export function MediaView({
  url,
  kind,
  name,
  onError,
}: {
  url: string;
  kind: "audio" | "video";
  name: string;
  onError?(): void;
}) {
  const [failed, setFailed] = useState(false);
  const fail = () => {
    setFailed(true);
    onError?.();
  };
  if (failed)
    return (
      <ViewerMessage name={name} title="Can't play this here">
        This browser can't play its format. Download it to play it in another app.
      </ViewerMessage>
    );
  return (
    <div className="viewer-stage viewer-media" data-kind={kind}>
      {kind === "video" ? (
        // biome-ignore lint/a11y/useMediaCaption: A file dot made has no captions to offer.
        <video
          className="viewer-video"
          src={`${url}#t=0.1`}
          controls
          playsInline
          preload="metadata"
          aria-label={name}
          onError={fail}
        />
      ) : (
        <div className="viewer-audio">
          <span className="viewer-tile viewer-tile-large" aria-hidden="true">
            {name.slice(name.lastIndexOf(".") + 1, name.lastIndexOf(".") + 5).toUpperCase()}
          </span>
          {/* biome-ignore lint/a11y/useMediaCaption: A sound file dot made has no captions to offer. */}
          <audio src={url} controls preload="metadata" aria-label={name} onError={fail} />
        </div>
      )}
    </div>
  );
}
