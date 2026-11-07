import type { ManualStreamInput, ScreenName, ScreenSelectionSnapshot } from "@localdot/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CellSummary } from "../cells/types.ts";
import type { ApiClient } from "../lib/api.ts";

// Whether the web browser's window is in front on the desktop: where dot is working, unless the user
// brought the window forward or sent it back (its dock item, its minimise light, Alt+Tab, or a press
// on it or beside it). Dot moving takes the stage with it again, and so does handing the computer
// back. A task on show that stops working leaves the stage on the screen it last used.
export interface StageFront {
  screen: ScreenName;
  // Where dot is, if a task is at work.
  dot: ScreenName | null;
  // The web browser to show while it is in front; dot's, or the running one the stage found.
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

const NOT_RUNNING = "The web browser isn't running yet. Try again in a moment.";

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
  // The screen the task on show last used on this computer.
  const [last, setLast] = useState<{ key: string; screen: ScreenName } | null>(null);
  // The web browser the computer has running: dot's, until a ticket says (`checked`) which runs now.
  const [found, setFound] = useState<{ parentId: string; cellId: string; checked: boolean } | null>(
    null,
  );
  // The computer whose web browser wasn't running when the stage last looked.
  const [missing, setMissing] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (holding !== wasHolding) {
    setWasHolding(holding);
    if (!holding) setPicked(null);
  }
  if (picked && picked.key !== key) setPicked(null);
  const dot = selection?.screen ?? null;
  // Another task or computer, or a new conversation, starts from the desktop, as a task does.
  const task = `${sessionId ?? ""}/${parentId ?? ""}`;
  const used = dot ?? (sessionId && last?.key === task ? last.screen : null);
  if (sessionId && used && (last?.key !== task || last.screen !== used))
    setLast({ key: task, screen: used });
  if (
    parentId &&
    selection?.screen === "browser" &&
    (found?.parentId !== parentId || found.cellId !== selection.cellId || found.checked)
  ) {
    setFound({ parentId, cellId: selection.cellId, checked: false });
    setMissing(null);
  }
  const current = picked?.key === key ? picked.screen : null;
  if (current === "browser" && dot !== "browser" && parentId && missing === parentId) {
    setPicked(null);
    setProblem(NOT_RUNNING);
  }
  const wanted = current ?? used ?? "desktop";
  // Without dot in it, the web browser shows once the stage has found it running; the one dot left
  // stays on show while a ticket says whether it still runs.
  const known = !!parentId && found?.parentId === parentId;
  const seek =
    wanted === "browser" && dot !== "browser" && !(known && found?.checked) && missing !== parentId;
  const screen = wanted === "browser" && dot !== "browser" && !known ? "desktop" : wanted;
  useEffect(() => {
    if (!seek || !parentId) return;
    let live = true;
    // A ticket says which browser the computer has, if it has one running.
    void api.post<{ cellId?: unknown }>(`/api/cells/${parentId}/browser-stream-ticket`).then(
      ({ cellId }) => {
        if (!live) return;
        if (typeof cellId === "string") setFound({ parentId, cellId, checked: true });
        else gone(parentId);
      },
      () => {
        if (live) gone(parentId);
      },
    );
    const gone = (id: string) => {
      setMissing(id);
      setFound(null);
    };
    return () => {
      live = false;
    };
  }, [api, seek, parentId]);
  const scale = parent?.scale;
  const browser = useMemo<ScreenSelectionSnapshot | undefined>(() => {
    if (selection?.screen === "browser") return selection;
    if (screen !== "browser" || !scale || !found || found.parentId !== parentId) return undefined;
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
      // Asked for again, the web browser is looked for again.
      if (next === "browser") setMissing(null);
      setPicked({ screen: next, key });
    },
    [key],
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
