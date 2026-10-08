import type { RecordingGapReason } from "@localdot/protocol";
import { gapCard } from "./replay-view.ts";

export function GapCard({ kind }: { kind: RecordingGapReason | "none" | "expired" | "failed" }) {
  const card = gapCard(kind);
  return (
    <div className="replay-gap-card" role="status">
      <strong>{card.title}</strong>
      <p>{card.body}</p>
    </div>
  );
}
