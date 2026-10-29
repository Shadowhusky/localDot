import { useCallback, useEffect, useState } from "react";
import { HELD_AFTER_MS, type StreamPicture } from "./live-stream.ts";

export type ScreenName = "desktop" | "browser";
// Why a picture this view has shown is away: its stream dropped, dot moved to the other screen, or
// the web browser is starting again.
export type AwayCause = "stream" | "switch" | "browser";
// A blip shows nothing, a brief gap a word, and a long one what is going on with a way to retry.
export type AwayLevel = "blip" | "brief" | "long";

export const LONG_AWAY_MS = 10_000;

// "first" until this view has shown the computer's picture: the screen is still on its way. After
// that a picture is "shown", or held on the stage while it is "away"; it never reads as first again
// until the computer goes down and comes back.
export type StageConnection =
  | { phase: "first" }
  | { phase: "shown" }
  | { phase: "away"; cause: AwayCause; screen: ScreenName; level: AwayLevel };

export interface ConnectionInput {
  // The computer whose screens this view watches, while it is up: another, or none, starts afresh.
  computer: string | null;
  screen: ScreenName;
  // What the stage last reported for `screen`.
  picture: StreamPicture;
  // The web browser's own computer is up, as far as its status says.
  screenUp: boolean;
  // The picture is put away on purpose (the computer is paused, or Replay covers the stage) and
  // something else says so.
  resting: boolean;
}

export interface ConnectionMemory {
  computer: string | null;
  // The screen this view last showed live, since its computer came up.
  seen: ScreenName | null;
  // When the picture went, and when it went for its current reason.
  away: { since: number; cause: AwayCause; causeSince: number } | null;
}

export const NO_CONNECTION: ConnectionMemory = { computer: null, seen: null, away: null };

// Returns `memory` itself when nothing changed, so a render can tell.
export function stepConnection(
  memory: ConnectionMemory,
  input: ConnectionInput,
  now: number,
): ConnectionMemory {
  const own =
    memory.computer === input.computer ? memory : { ...NO_CONNECTION, computer: input.computer };
  if (input.picture === "live")
    return own.seen === input.screen && !own.away
      ? own
      : { computer: own.computer, seen: input.screen, away: null };
  // A hidden page and a paused computer lose nothing; the clock starts when they come back.
  if (!own.seen || input.resting || input.picture === "suspended")
    return own.away ? { ...own, away: null } : own;
  const cause: AwayCause =
    input.screen !== own.seen ? "switch" : input.screenUp ? "stream" : "browser";
  if (own.away?.cause === cause) return own;
  return { ...own, away: { since: own.away?.since ?? now, cause, causeSince: now } };
}

export function connectionAt(
  memory: ConnectionMemory,
  input: ConnectionInput,
  now: number,
): StageConnection {
  if (input.picture === "live") return { phase: "shown" };
  if (!memory.seen) return { phase: "first" };
  const away = memory.away;
  if (!away) return { phase: "shown" };
  // A held stream has already been gone a second.
  const level: AwayLevel =
    input.picture !== "held" && now - away.since < HELD_AFTER_MS
      ? "blip"
      : now - away.causeSince < LONG_AWAY_MS
        ? "brief"
        : "long";
  return { phase: "away", cause: away.cause, screen: input.screen, level };
}

// When a connection that is away next changes level by time alone.
function nextLevelAt(memory: ConnectionMemory, connection: StageConnection): number | null {
  if (connection.phase !== "away" || !memory.away) return null;
  if (connection.level === "blip") return memory.away.since + HELD_AFTER_MS;
  if (connection.level === "brief") return memory.away.causeSince + LONG_AWAY_MS;
  return null;
}

// The stage's connection as this view has known it. Kept by the page, not the stage, so a stage
// that remounts never forgets it has shown the computer.
export function useStageConnection(input: ConnectionInput): StageConnection {
  const [memory, setMemory] = useState(NO_CONNECTION);
  const [, setTick] = useState(0);
  const now = Date.now();
  const next = stepConnection(memory, input, now);
  if (next !== memory) setMemory(next);
  const connection = connectionAt(next, input, now);
  const wake = nextLevelAt(next, connection);
  useEffect(() => {
    if (wake === null) return;
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(0, wake - Date.now()));
    return () => clearTimeout(timer);
  }, [wake]);
  return connection;
}

// What the stage last reported of the screen on show. It reports a commit late, so a screen just
// selected, or one whose computer has just gone down (the web browser starting again), has none.
export function useStagePicture(screen: ScreenName, up: boolean) {
  const [shot, setShot] = useState<{ picture: StreamPicture; screen: ScreenName }>({
    picture: "none",
    screen,
  });
  const onPicture = useCallback(
    (picture: StreamPicture, screen: ScreenName) => setShot({ picture, screen }),
    [],
  );
  return { picture: shot.screen === screen && up ? shot.picture : "none", onPicture };
}
