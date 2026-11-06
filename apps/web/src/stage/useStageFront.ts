import type { ManualStreamInput, ScreenName, ScreenSelectionSnapshot } from "@localdot/protocol";
import { useCallback, useMemo, useState } from "react";
import type { CellSummary } from "../cells/types.ts";
import type { ApiClient } from "../lib/api.ts";

// Whether the web browser's window is in front on the desktop: where dot is working, unless the user
// brought the window forward or sent it back (a press on it or beside it, or its entry on the menu
// bar). Dot moving takes the stage with it again, and so does handing the computer back.
export interface StageFront {
  screen: ScreenName;
  // Where dot is, if a task is at work.
  dot: ScreenName | null;
  // The web browser to show while it is in front; dot's, or the one the user's press found.
  browser: ScreenSelectionSnapshot | undefined;
  // Why the screen the user picked can't come forward.
  problem: string | null;
  pick(screen: ScreenName): void;
  // Says which screen an input from the page is for, when that isn't dot's.
  route(input: ManualStreamInput): ManualStreamInput;
}

interface Pick {
  screen: ScreenName;
  // The task and its screen when it was picked: either changing ends it.
  key: string;
}

export function useStageFront(
  api: ApiClient,
  parent: CellSummary | null,
  selection: ScreenSelectionSnapshot | undefined,
  sessionId: string | null | undefined,
  holding: boolean,
): StageFront {
  const parentId = parent?.id;
  const key = `${sessionId ?? ""}/${selection?.screen ?? "desktop"}/${parentId ?? ""}`;
  const [picked, setPicked] = useState<Pick | null>(null);
  const [wasHolding, setWasHolding] = useState(holding);
  const [found, setFound] = useState<{ parentId: string; cellId: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (holding !== wasHolding) {
    setWasHolding(holding);
    if (!holding) setPicked(null);
  }
  if (picked && picked.key !== key) setPicked(null);
  const current = picked?.key === key ? picked.screen : null;
  const dot = selection?.screen ?? null;
  const screen = current ?? dot ?? "desktop";
  const scale = parent?.scale;
  const browser = useMemo<ScreenSelectionSnapshot | undefined>(() => {
    if (selection?.screen === "browser") return selection;
    if (screen !== "browser" || !scale || found?.parentId !== parentId || !found) return undefined;
    return {
      screen: "browser",
      cellId: found.cellId,
      geometry: { w: 1280 * scale, h: 800 * scale, scale },
      revision: 1,
    };
  }, [selection, screen, scale, found, parentId]);
  const pick = useCallback(
    (next: ScreenName) => {
      setProblem(null);
      if (next === "desktop" || selection?.screen === "browser") {
        setPicked({ screen: next, key });
        return;
      }
      if (!parentId) return;
      // A ticket says which browser the computer has, if it has one running.
      void api.post<{ cellId?: unknown }>(`/api/cells/${parentId}/browser-stream-ticket`).then(
        ({ cellId }) => {
          if (typeof cellId !== "string") throw new Error("no browser");
          setFound({ parentId, cellId });
          setPicked({ screen: next, key });
        },
        () => setProblem("The web browser isn't running yet. Try again in a moment."),
      );
    },
    [api, key, parentId, selection?.screen],
  );
  const route = useCallback(
    (input: ManualStreamInput): ManualStreamInput => {
      const { screen: named, ...bare } = input;
      const to = named ?? screen;
      return (to === (dot ?? "desktop") ? bare : { ...bare, screen: to }) as ManualStreamInput;
    },
    [screen, dot],
  );
  return useMemo(
    () => ({ screen, dot, browser, problem, pick, route }),
    [screen, dot, browser, problem, pick, route],
  );
}
