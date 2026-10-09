import type { ProofFrame, ResultProof } from "@localdot/protocol";
import type { ReactNode } from "react";
import { markdownToPlain } from "../agent/markdown.ts";
import { clock } from "../copy/format.ts";
import type { ApiClient } from "../lib/api.ts";
import { ReplayImage } from "../replay/ReplayImage.tsx";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
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
  // The recording covers the whole turn, screenshots or not; under a second there is nothing to see.
  const exportable =
    proof.state === "ready" &&
    EXPORTABLE.has(proof.proof.recording) &&
    !!entry &&
    entry.endMs - entry.startMs >= 1000;
  const frames = entry?.frames ?? [];
  const checked = entry?.checked && markdownToPlain(entry.checked);
  // Nothing is held for frames until the answer says there are some: most results have none.
  return (
    <section className="proof" aria-label="Proof">
      {frames.length > 0 && (
        <ol className="proof-frames">
          {frames.map((frame) => (
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
      {checked && (
        <p className="proof-checked" title={`Checked: ${checked}`}>
          <Icon name="check-circle" size={14} className="proof-checked-icon" />
          <span className="proof-checked-text">Checked: {checked}</span>
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
