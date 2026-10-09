import { useEffect, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { ReplayImage } from "../replay/ReplayImage.tsx";
import type { KeyUseRowView } from "../session/key-uses.ts";
import type { StepRowView } from "../session/session-view.ts";
import { cachedThumbnail, releaseThumbnail, thumbnailUrl } from "../session/thumbnails.ts";
import { Icon } from "../ui/Icon.tsx";
import type { ActivityEntry } from "./activity.ts";
import { DiffViewer } from "./DiffViewer.tsx";
import type { AgentChange } from "./model.ts";
import { SafeMarkdown } from "./SafeMarkdown.tsx";
import { TerminalViewer } from "./TerminalViewer.tsx";

// The observe frame is 1280×800 CSS px; target rects are device px, so they are divided by the scale.
const FRAME_W = 1280;
const FRAME_H = 800;
const MIN_WINDOW = 320;

export interface FrameCrop {
  image: { width: string; left: string; top: string };
  target: { left: string; top: string; width: string; height: string } | null;
}

const pct = (value: number) => `${(value * 100).toFixed(3)}%`;

// A 16:10 window around the target, wide enough to show what surrounds it; the whole frame without one.
export function frameCrop(target: StepRowView["target"], scale: number): FrameCrop {
  if (!target) return { image: { width: "100%", left: "0%", top: "0%" }, target: null };
  const t = {
    x: target.x / scale,
    y: target.y / scale,
    w: target.w / scale,
    h: target.h / scale,
  };
  const w = Math.min(FRAME_W, Math.max(MIN_WINDOW, Math.max(t.w, t.h * 1.6) * 4));
  const h = (w * FRAME_H) / FRAME_W;
  const x = Math.min(Math.max(t.x + t.w / 2 - w / 2, 0), FRAME_W - w);
  const y = Math.min(Math.max(t.y + t.h / 2 - h / 2, 0), FRAME_H - h);
  return {
    image: { width: pct(FRAME_W / w), left: pct(-x / w), top: pct(-y / h) },
    target: {
      left: pct((t.x - x) / w),
      top: pct((t.y - y) / h),
      width: pct(t.w / w),
      height: pct(t.h / h),
    },
  };
}

function LiveFrame({
  api,
  sessionId,
  row,
  scale,
}: {
  api: ApiClient;
  sessionId: string;
  row: StepRowView;
  scale: number;
}) {
  const frameId = row.frameId;
  const [image, setImage] = useState(() => {
    const url = frameId ? cachedThumbnail(api, sessionId, frameId) : undefined;
    return url && frameId ? { frameId, url } : null;
  });
  useEffect(() => {
    if (!frameId) return;
    let cancelled = false;
    thumbnailUrl(api, sessionId, frameId).then(
      (url) => {
        if (!cancelled) setImage({ frameId, url });
      },
      () => {},
    );
    return () => {
      cancelled = true;
      releaseThumbnail(api, sessionId, frameId);
    };
  }, [api, sessionId, frameId]);
  if (!frameId) return <p className="activity-detail-note">No screenshot for this step.</p>;
  const crop = frameCrop(row.target, scale);
  const url = image?.frameId === frameId ? image.url : undefined;
  return (
    <div className="activity-frame" data-loaded={url ? "" : undefined}>
      {url && (
        <img
          className="activity-frame-crop"
          src={url}
          alt=""
          draggable={false}
          style={crop.image}
        />
      )}
      {url && crop.target && row.delivery === "delivered" && (
        <span className="activity-frame-target" style={crop.target} />
      )}
    </div>
  );
}

function KeysUsed({ keys }: { keys: readonly KeyUseRowView[] }) {
  return (
    <ul className="activity-keys" aria-label="Keys used">
      {keys.map((key) => (
        <li key={key.id}>
          <Icon name="key-round" size={12} />
          <span className="activity-keys-label">{key.label}</span>
          {key.count > 1 && <span className="num">×{key.count}</span>}
          <span className="activity-keys-request">{key.detail}</span>
        </li>
      ))}
    </ul>
  );
}

export function ActivityDetail({
  entry,
  changes,
  api,
  sessionId,
  scale,
  replay,
}: {
  entry: ActivityEntry;
  changes: readonly AgentChange[];
  api: ApiClient;
  sessionId: string;
  scale: number;
  replay: boolean;
}) {
  const { row } = entry;
  if (row.kind === "key") return null;
  const own = changes.filter((change) => change.type === "file" && change.step === row.id);
  const agent = row.agent;
  return (
    <div className="activity-detail">
      {agent?.note && (agent.status === "ok" || !agent.status) && (
        <div className="activity-detail-note">
          <SafeMarkdown text={agent.note} compact />
        </div>
      )}
      {row.computer &&
        (replay ? (
          <div className="activity-frame" data-loaded="">
            <ReplayImage api={api} sessionId={sessionId} frameId={row.computer.frameId ?? null} />
          </div>
        ) : (
          <LiveFrame api={api} sessionId={sessionId} row={row.computer} scale={scale} />
        ))}
      {agent && (agent.tool || agent.terminal || agent.outputTruncated) && (
        <TerminalViewer step={agent} />
      )}
      {own.map((change) => (
        <DiffViewer key={change.id} change={change} compact={own.length === 1} />
      ))}
      {entry.keys.length > 0 && <KeysUsed keys={entry.keys} />}
    </div>
  );
}
