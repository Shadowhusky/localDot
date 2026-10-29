import { useEffect } from "react";
import { announce, withdraw } from "../ui/Announcer.tsx";
import { Button } from "../ui/Button.tsx";
import { Spinner } from "../ui/Spinner.tsx";
import type { AwayCause, ScreenName, StageConnection } from "./connection.ts";

const SCREEN_NAME: Record<ScreenName, string> = { desktop: "desktop", browser: "web browser" };

export function awayWords(cause: AwayCause, screen: ScreenName) {
  switch (cause) {
    case "switch":
      return {
        brief: `Switching to the ${SCREEN_NAME[screen]}…`,
        title: `Still switching to the ${SCREEN_NAME[screen]}`,
        detail: "Its picture is taking longer than usual.",
      };
    case "browser":
      return {
        brief: "The web browser is restarting…",
        title: "The web browser is still restarting",
        detail: "Your sign-ins are kept. The picture returns once it's back.",
      };
    case "stream":
      return {
        brief: "Reconnecting…",
        title: "Still reconnecting",
        detail: "Your computer keeps running. This is its last picture.",
      };
  }
}

// Over the last picture while it is away: nothing for a blip (only a dip while dot changes
// screens), then a word, then what is going on and a way to try again. The HUD and the screen toast
// already say a gap and a switch, so only what lasts is announced.
export function StageNotice({
  connection,
  onRetry,
}: {
  connection: StageConnection;
  onRetry?(): void;
}) {
  const away = connection.phase === "away" ? connection : null;
  const words = away && awayWords(away.cause, away.screen);
  const long = away?.level === "long";
  const spoken = long && words ? `${words.title}. ${words.detail}` : null;
  useEffect(() => {
    if (!spoken) return;
    announce("stage", spoken);
    return () => withdraw("stage");
  }, [spoken]);
  if (!away || !words || (away.level === "blip" && away.cause !== "switch")) return null;
  return (
    <div className="stage-away" data-level={away.level} data-cause={away.cause}>
      {away.level !== "blip" && (
        <div className="stage-away-card">
          <Spinner size={14} className="stage-away-spinner" />
          <div className="stage-away-text">
            <p className="stage-away-title">{long ? words.title : words.brief}</p>
            {long && <p className="stage-away-detail">{words.detail}</p>}
          </div>
          {long && onRetry && away.cause !== "browser" && (
            <Button size="sm" onClick={onRetry}>
              Try again
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
