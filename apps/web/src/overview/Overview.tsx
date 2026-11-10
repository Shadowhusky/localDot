import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { ConversationRow } from "../agent/conversation-list.ts";
import type { ApiClient } from "../lib/api.ts";
import { OverviewGrid } from "./OverviewGrid.tsx";
import type { TilePictureProps } from "./OverviewTile.tsx";
import { useOverviewPreferences } from "./overview-preferences.ts";
import { TilePicture } from "./TilePicture.tsx";
import { useOverviewTiles } from "./useOverviewTiles.ts";

// How often the ages on the tiles move on.
const AGE_TICK_MS = 30_000;

// The overview as the app shows it: the grid, fed by the daemon for the tiles in view while it is on
// screen, with this browser's size and filter.
export function Overview({
  api,
  rows,
  shown,
  current,
  reason,
  heading,
  onOpen,
}: {
  api: ApiClient;
  rows: readonly ConversationRow[];
  shown: boolean;
  current: string | null;
  reason?: string | undefined;
  heading?: ReactNode;
  onOpen(row: ConversationRow): void;
}) {
  const [preferences, setPreferences] = useOverviewPreferences();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!shown) return;
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), AGE_TICK_MS);
    return () => clearInterval(timer);
  }, [shown]);
  const [inView, setInView] = useState<readonly string[]>([]);
  const [hand, setHand] = useState<string | null>(null);
  const tiles = useOverviewTiles(api, inView, { active: shown, fast: hand !== null });
  const Picture = useMemo(
    () =>
      function Picture(props: TilePictureProps) {
        return <TilePicture api={api} {...props} />;
      },
    [api],
  );
  return (
    <OverviewGrid
      rows={rows}
      tiles={tiles}
      now={now}
      density={preferences.density}
      filter={preferences.filter}
      onDensity={(density) => setPreferences({ density })}
      onFilter={(filter) => setPreferences({ filter })}
      Picture={Picture}
      shown={shown}
      reason={reason}
      current={current}
      heading={heading}
      onOpen={onOpen}
      onInView={setInView}
      onHand={setHand}
    />
  );
}
