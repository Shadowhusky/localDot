import { type SyntheticEvent, useState } from "react";
import { ViewerMessage } from "./states.tsx";

// A format this browser can't play, which trying again won't change, or a load that failed. A player
// says the same of a format and of an address that no longer answers, so the address is asked.
async function whyFailed(media: HTMLMediaElement, url: string): Promise<"format" | "load"> {
  const { error } = media;
  if (error && error.code === error.MEDIA_ERR_NETWORK) return "load";
  try {
    const reply = await fetch(url, { method: "HEAD", cache: "no-store" });
    return reply.ok ? "format" : "load";
  } catch {
    return "load";
  }
}

// Sound or video with the browser's own controls, streamed from the file. A video shows its first
// moments as its poster, and plays in place on a phone rather than taking over the screen.
export function MediaPlayer({
  url,
  kind,
  name,
  onFail,
}: {
  url: string;
  kind: "audio" | "video";
  name: string;
  onFail(why: "format" | "load"): void;
}) {
  const fail = (event: SyntheticEvent<HTMLMediaElement>) =>
    void whyFailed(event.currentTarget, url).then(onFail);
  return kind === "video" ? (
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
    // biome-ignore lint/a11y/useMediaCaption: A sound file dot made has no captions to offer.
    <audio src={url} controls preload="metadata" aria-label={name} onError={fail} />
  );
}

// A player in the viewer's stage; what it can't play shows the file's card.
export function MediaView({
  url,
  kind,
  name,
  retry,
  onError,
}: {
  url: string;
  kind: "audio" | "video";
  name: string;
  retry?(): void;
  onError?(): void;
}) {
  const [failed, setFailed] = useState<"format" | "load" | null>(null);
  if (failed)
    return failed === "load" ? (
      <ViewerMessage name={name} title="Couldn't load this file" retry={retry} />
    ) : (
      <ViewerMessage name={name} />
    );
  const player = (
    <MediaPlayer
      url={url}
      kind={kind}
      name={name}
      onFail={(why) => {
        setFailed(why);
        onError?.();
      }}
    />
  );
  return (
    <div className="viewer-stage viewer-media" data-kind={kind}>
      {kind === "video" ? (
        player
      ) : (
        <div className="viewer-audio">
          <span className="viewer-tile viewer-tile-large" aria-hidden="true">
            {name.slice(name.lastIndexOf(".") + 1, name.lastIndexOf(".") + 5).toUpperCase()}
          </span>
          {player}
        </div>
      )}
    </div>
  );
}
