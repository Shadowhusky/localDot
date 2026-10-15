import type { Attention } from "@localdot/protocol";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ComputerPhase } from "../cells/hud-state.ts";
import type { StatusRow } from "../session/status.ts";
import {
  type DayPart,
  GREETINGS,
  TIPS,
  type Tip,
  type TipAction,
  type TipSignals,
} from "./tips.ts";
import type { Voice } from "./voices.ts";

// A tip stays this long before the next one.
export const TIP_MS = 25_000;
export const TIPS_KEY = "localdot.tips.v1";

// Rows with no task at work and nothing waiting on the user.
const RESTING = new Set<StatusRow>(["ready", "done", "stopped"]);

export interface BandScene {
  row: StatusRow;
  computer: ComputerPhase;
  attention: Attention | null;
  // What the band says otherwise.
  line: string;
  // Something else has the user's eye: the curtain, Replay, setup, an error, or the computer is
  // theirs.
  covered: boolean;
}

// dot greets and gives tips only while no task runs and nothing needs the user.
export const restingBand = (scene: BandScene) =>
  scene.computer === "live" &&
  RESTING.has(scene.row) &&
  scene.attention !== "needs_you" &&
  scene.attention !== "blocked" &&
  !scene.line &&
  !scene.covered;

export function dayPart(hour: number): DayPart {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 23) return "evening";
  return "night";
}

export function greeting(at: Date, pick = Math.random(), voice?: Voice): string {
  const lines = (voice?.greetings ?? GREETINGS)[dayPart(at.getHours())];
  return lines[Math.min(lines.length - 1, Math.floor(pick * lines.length))] ?? "";
}

// The tips for what this screen has, those for features the user hasn't used first, then those it
// can't tell about, then the rest.
export function rankTips(tips: readonly Tip[], signals: TipSignals): Tip[] {
  const rank = (tip: Tip) => {
    const used = tip.used?.(signals);
    return used === false ? 0 : used === undefined ? 1 : 2;
  };
  return tips
    .filter((tip) => tip.shows?.(signals) ?? true)
    .map((tip) => ({ tip, rank: rank(tip) }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ tip }) => tip);
}

// The first tip not yet shown. Once all have been, the round starts again, never with the tip just
// shown.
export function nextTip(
  ranked: readonly Tip[],
  seen: readonly string[],
): { tip: Tip; seen: string[] } | null {
  const fresh = ranked.find((tip) => !seen.includes(tip.id));
  if (fresh) return { tip: fresh, seen: [...seen, fresh.id] };
  const last = seen.findLast((id) => ranked.some((tip) => tip.id === id));
  const again = ranked.find((tip) => tip.id !== last) ?? ranked[0];
  return again ? { tip: again, seen: [again.id] } : null;
}

export const tipText = (tip: Tip, signals: TipSignals) =>
  typeof tip.text === "string" ? tip.text : tip.text(signals);

// The tips this viewer has seen in this round; null when the browser won't say.
export function seenTips(): string[] | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(TIPS_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return null;
  }
}

function keepSeen(seen: readonly string[]) {
  try {
    localStorage.setItem(TIPS_KEY, JSON.stringify(seen));
  } catch {}
}

export interface IdleLine {
  text: string;
  action?: TipAction;
}

export interface IdleInput {
  resting: boolean;
  // Another panel covers Watch; preserve its line without rotating tips.
  suspended?: boolean;
  // The rotation waits: the page is hidden or the pointer is over the band.
  held: boolean;
  signals: TipSignals;
  tips?: readonly Tip[];
  // The chosen dot's words: its greetings, its hello when it is chosen, and the lines about its own
  // work that take every other turn with the tips. Without one, plain greetings and tips only.
  voice?: Voice;
}

// What dot says while the band rests: a greeting the first time on this page, then a line every
// TIP_MS, a tip and then one of its own in turn. A newly chosen dot says hello at once. After a task
// it waits one turn in silence before its next line.
export function useIdleLine({
  resting,
  suspended = false,
  held,
  signals,
  tips = TIPS,
  voice,
}: IdleInput): IdleLine | null {
  const [line, setLine] = useState<IdleLine | null>(null);
  const greeted = useRef(false);
  const seen = useRef<string[]>([]);
  const turn = useRef({ own: false, next: 0 });
  const heard = useRef(voice);
  const latest = useRef({ signals, tips, voice });
  latest.current = { signals, tips, voice };
  useEffect(() => {
    if (suspended) return;
    if (!resting) {
      setLine(null);
      return;
    }
    if (greeted.current) return;
    greeted.current = true;
    setLine({ text: greeting(new Date(), Math.random(), latest.current.voice) });
  }, [resting, suspended]);
  useEffect(() => {
    if (heard.current === voice) return;
    heard.current = voice;
    turn.current = { own: false, next: 0 };
    if (voice && resting && !suspended) setLine({ text: voice.hello });
  }, [voice, resting, suspended]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new line starts the wait again
  useEffect(() => {
    if (!resting || suspended || held) return;
    const timer = setTimeout(() => {
      const { signals, tips, voice } = latest.current;
      const own = turn.current.own && !!voice?.lines.length;
      turn.current.own = !turn.current.own;
      if (own && voice) {
        setLine({ text: voice.lines[turn.current.next % voice.lines.length] ?? "" });
        turn.current.next += 1;
        return;
      }
      const next = nextTip(rankTips(tips, signals), seenTips() ?? seen.current);
      if (!next) return;
      seen.current = next.seen;
      keepSeen(next.seen);
      setLine({
        text: tipText(next.tip, signals),
        ...(next.tip.action ? { action: next.tip.action } : {}),
      });
    }, TIP_MS);
    return () => clearTimeout(timer);
  }, [resting, suspended, held, line]);
  return resting && !suspended ? line : null;
}

const subscribeVisibility = (onChange: () => void) => {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
};

export const usePageHidden = () =>
  useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "hidden");
