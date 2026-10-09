import type { ProofFrame, ResultProof } from "@localdot/protocol";
import type { ReactNode } from "react";
import { clock } from "../copy/format.ts";
import type { ApiClient } from "../lib/api.ts";
import { ReplayImage } from "../replay/ReplayImage.tsx";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Skeleton } from "../ui/Skeleton.tsx";
import { ThumbnailButton } from "../ui/Thumbnail.tsx";
import { openReplay } from "./replay-link.ts";
import type { ProofState } from "./useProof.ts";

const ROLE: Record<ProofFrame["role"], string> = {
  start: "Start",
  change: "Key change",
  end: "End",
};
const WATCH: Record<ProofFrame["role"], string> = {
  start: "Watch from the start",
  change: "Watch from the key change",
  end: "Watch from the end",
};
const EXPORTABLE = new Set(["recording", "complete", "recovered"]);

export function proofOf(proof: ProofState, resultId: string): ResultProof | undefined {
  return proof.state === "ready"
    ? proof.proof.results.find((entry) => entry.resultId === resultId)
    : undefined;
}

// Proof of the work behind a result: three moments from its recording to open Replay at, what dot
// checked about its files, and the way to watch or export that part of the recording. Anything
// else that acts on the whole result goes at the end of its buttons.
export function ProofStrip({
  api,
  sessionId,
  resultId,
  proof,
  end,
}: {
  api: ApiClient;
  sessionId: string;
  resultId: string;
  proof: ProofState;
  end?: ReactNode;
}) {
  const entry = proofOf(proof, resultId);
  const loading = proof.state === "loading";
  const exportable =
    proof.state === "ready" && EXPORTABLE.has(proof.proof.recording) && !!entry?.frames.length;
  const frames = entry?.frames ?? [];
  return (
    <section className="proof" aria-label="Proof">
      {(loading || frames.length > 0) && (
        <ol className="proof-frames">
          {loading
            ? ["start", "change", "end"].map((role) => (
                <li key={role} className="proof-frame">
                  <Skeleton loading shape="block" width="100%" className="proof-bone" />
                </li>
              ))
            : frames.map((frame) => (
                <li key={frame.frameId} className="proof-frame">
                  <ThumbnailButton
                    label={WATCH[frame.role]}
                    onClick={() => openReplay(sessionId, { tMs: frame.tMs })}
                  >
                    <ReplayImage api={api} sessionId={sessionId} frameId={frame.frameId} />
                  </ThumbnailButton>
                  <span className="proof-caption" aria-hidden="true">
                    {ROLE[frame.role]}
                  </span>
                </li>
              ))}
        </ol>
      )}
      {entry?.checked && (
        <p className="proof-checked" title={`Checked: ${entry.checked}`}>
          <Icon name="check-circle" size={14} className="proof-checked-icon" />
          <span className="proof-checked-text">Checked: {entry.checked}</span>
        </p>
      )}
      {(entry || end) && (
        <div className="proof-actions">
          {entry && (
            <Button
              variant="quiet"
              size="sm"
              icon="play"
              onClick={() => openReplay(sessionId, { tMs: entry.startMs })}
            >
              Watch replay ({clock((entry.endMs - entry.startMs) / 1000)})
            </Button>
          )}
          {entry && exportable && (
            <Button
              variant="quiet"
              size="sm"
              icon="share"
              onClick={() =>
                openReplay(sessionId, {
                  tMs: entry.startMs,
                  exportRange: { fromMs: entry.startMs, toMs: entry.endMs },
                })
              }
            >
              Export proof video
            </Button>
          )}
          {end && <span className="proof-end">{end}</span>}
        </div>
      )}
    </section>
  );
}
