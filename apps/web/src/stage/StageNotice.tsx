import { useEffect } from "react";
import { t } from "../i18n/index.ts";
import { announce, withdraw } from "../ui/Announcer.tsx";
import { Button } from "../ui/Button.tsx";
import { Spinner } from "../ui/Spinner.tsx";
import type { AwayCause, ScreenName, StageConnection } from "./connection.ts";

export function awayWords(cause: AwayCause, screen: ScreenName) {
  switch (cause) {
    case "switch":
      return screen === "browser"
        ? {
            brief: t`Switching to the web browser…`,
            title: t`Still switching to the web browser`,
            detail: t`Its picture is taking longer than usual.`,
          }
        : {
            brief: t`Switching to the desktop…`,
            title: t`Still switching to the desktop`,
            detail: t`Its picture is taking longer than usual.`,
          };
    case "browser":
      return {
        brief: t`The web browser is restarting…`,
        title: t`The web browser is still restarting`,
        detail: t`Your sign-ins are kept. The picture returns once it's back.`,
      };
    case "stream":
      return {
        brief: t`Reconnecting…`,
        title: t`Still reconnecting`,
        detail: t`Your computer keeps running. This is its last picture.`,
      };
  }
}

// While the web browser restarts for a sign-in, its window is gone for a few seconds: a word over
// the picture says why, so it doesn't read as the browser vanishing.
export function RelaunchNotice() {
  return (
    <div className="stage-away" data-level="long" data-cause="relaunch">
      <div className="stage-away-card">
        <Spinner size={14} className="stage-away-spinner" />
        <div className="stage-away-text">
          <p className="stage-away-title">{t`Restarting the browser for your sign-in…`}</p>
          <p className="stage-away-detail">
            {t`dot's connection is off while you sign in. Your tabs come back in a moment.`}
          </p>
        </div>
      </div>
    </div>
  );
}

// Only a move dot makes in its running task is news. With no task at work the page goes back to the
// desktop by itself (a task ended, a new conversation began) and dot has not moved.
export function screenMoveNote(to: ScreenName, dotChose: boolean): string | null {
  if (!dotChose) return null;
  return to === "browser" ? t`dot is working in the web browser` : t`dot is back on the desktop`;
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
  const spoken = long && words ? t`${words.title}. ${words.detail}` : null;
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
              {t`Try again`}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
