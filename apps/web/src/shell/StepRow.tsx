import { msToSeconds } from "@localdot/protocol";
import { useEffect, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import type { StepRowView } from "../session/session-view.ts";
import { releaseThumbnail, thumbnailUrl } from "../session/thumbnails.ts";

// A 160×100 crop of the step's settled frame around its target (the mockup's thumb), from the
// 1280×800 observe image; target rects are device px, so they are divided by the scale.
export function StepRow({
  row,
  sessionId,
  scale,
  api,
  current,
}: {
  row: StepRowView;
  sessionId: string;
  scale: number;
  api: ApiClient;
  current: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!row.frameId) return;
    let cancelled = false;
    thumbnailUrl(api, sessionId, row.frameId).then(
      (u) => {
        if (!cancelled) setUrl(u);
      },
      () => {},
    );
    return () => {
      cancelled = true;
      releaseThumbnail(api, sessionId, row.frameId as string);
    };
  }, [api, sessionId, row.frameId]);
  const t = row.target
    ? {
        x: row.target.x / scale,
        y: row.target.y / scale,
        w: row.target.w / scale,
        h: row.target.h / scale,
      }
    : null;
  const z = t ? Math.min(1, Math.max(0.25, 60 / Math.max(t.w, t.h, 30))) : 0.125;
  const cx = t ? t.x + t.w / 2 : 640;
  const cy = t ? t.y + t.h / 2 : 400;
  return (
    <div className={current ? "step now" : "step"} data-testid="step-row" data-status={row.status}>
      <div className="step-cap">{row.label}</div>
      <div className="step-row">
        <div className="thumb">
          {url && (
            <img
              src={url}
              alt=""
              style={{ width: 1280 * z, left: 80 - cx * z, top: 50 - cy * z }}
            />
          )}
          {t && url && (
            <span
              className="tb"
              style={{
                left: 80 + (t.x - cx) * z - 2,
                top: 50 + (t.y - cy) * z - 2,
                width: t.w * z + 4,
                height: t.h * z + 4,
              }}
            />
          )}
        </div>
        <div className="meta">
          <span
            className={row.status === "ok" ? "okg" : row.status === "doing" ? "pr" : "err"}
            role="img"
            aria-label={row.status}
          />
          <span className="num">
            {row.durationMs === null ? "…" : `${msToSeconds(row.durationMs).toFixed(1)} s`}
          </span>
        </div>
      </div>
    </div>
  );
}
