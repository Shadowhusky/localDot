import { OverviewReply, type OverviewTile } from "@localdot/protocol";
import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { replayOrigin } from "../replay/useReplay.ts";

// How often the tiles in view are asked about: about once a second, and more often while one is in
// hand, so its picture follows dot closely. A reply that changed nothing is a bodiless 304.
export const OVERVIEW_POLL_MS = 1_000;
export const OVERVIEW_FAST_MS = 400;

const NONE: ReadonlyMap<string, OverviewTile> = new Map();

// What the daemon says of each task in `ids` beyond the conversation list, read while `active` and
// the page is looked at, and kept between reads so a tile scrolled away and back shows at once.
export function useOverviewTiles(
  api: ApiClient,
  ids: readonly string[],
  { active, fast }: { active: boolean; fast: boolean },
): ReadonlyMap<string, OverviewTile> {
  const [tiles, setTiles] = useState(NONE);
  const asked = ids.join(",");
  const tag = useRef<{ asked: string; etag: string } | null>(null);
  useEffect(() => {
    if (!active || !asked) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading: AbortController | null = null;
    let stopped = false;
    const read = async () => {
      clearTimeout(timer);
      if (stopped || document.hidden) return;
      reading?.abort();
      const controller = new AbortController();
      reading = controller;
      const held = tag.current?.asked === asked ? tag.current.etag : undefined;
      try {
        const response = await api.fetch(`${replayOrigin(api)}/api/overview?ids=${asked}`, {
          headers: {
            authorization: api.authorization(),
            ...(held ? { "if-none-match": held } : {}),
          },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        });
        if (response.status === 401) api.rejectUnauthorized?.();
        if (response.ok) {
          const reply = OverviewReply.parse(await response.json());
          const etag = response.headers.get("etag");
          tag.current = etag ? { asked, etag } : null;
          if (!controller.signal.aborted)
            setTiles((was) => {
              const next = new Map(was);
              for (const tile of reply.tiles) next.set(tile.sessionId, tile);
              return next;
            });
        }
      } catch {}
      if (reading === controller && !stopped)
        timer = setTimeout(read, fast ? OVERVIEW_FAST_MS : OVERVIEW_POLL_MS);
    };
    const looked = () => {
      if (!document.hidden) void read();
    };
    void read();
    document.addEventListener("visibilitychange", looked);
    return () => {
      stopped = true;
      clearTimeout(timer);
      reading?.abort();
      document.removeEventListener("visibilitychange", looked);
    };
  }, [api, asked, active, fast]);
  return tiles;
}
