import type { RecordingGapReason } from "@localdot/protocol";
import { useRef } from "react";
import { gapCard } from "./replay-view.ts";

export type GapKind = RecordingGapReason | "none" | "expired" | "failed";

// Docked at the foot of the picture. It stays mounted, so it fades out still holding its words.
export function GapCard({ kind }: { kind: GapKind | undefined }) {
  const last = useRef(kind);
  if (kind) last.current = kind;
  const card = last.current && gapCard(last.current);
  return (
    <div className="replay-gap-card" role="status" data-shown={kind ? "" : undefined}>
      {card && (
        <>
          <p className="replay-gap-title">{card.title}</p>
          <p className="replay-gap-body">{card.body}</p>
        </>
      )}
    </div>
  );
}
