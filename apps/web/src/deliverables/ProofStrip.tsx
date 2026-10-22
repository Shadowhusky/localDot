import type { ResultProof } from "@localdot/protocol";
import { markdownToPlain } from "../agent/markdown.ts";
import { clock } from "../copy/format.ts";
import type { ApiClient } from "../lib/api.ts";
import { ReplayImage } from "../replay/ReplayImage.tsx";
import { RowMenu } from "../routines/RowMenu.tsx";
import { PlayRow, type PlayRowProps } from "../ui/Card.tsx";
import { Icon } from "../ui/Icon.tsx";
import { MenuItem } from "../ui/Menu.tsx";
import { openReplay } from "./replay-link.ts";
import type { ProofState } from "./useProof.ts";

const EXPORTABLE = new Set(["recording", "complete", "recovered"]);
// What the row says before the proof is known, or when there is none.
const UNPROVEN = { label: "Replay this task", title: "Replay" } as const;

export function proofOf(proof: ProofState, resultId: string): ResultProof | undefined {
  return proof.state === "ready"
    ? proof.proof.results.find((entry) => entry.resultId === resultId)
    : undefined;
}

function ProofRow(props: PlayRowProps) {
  return (
    <section className="proof" aria-label="Proof">
      <PlayRow {...props} />
    </section>
  );
}

// Proof of the work behind a result, on one row: the recording's last moment, how long the work
// took and what dot checked about its files. The row opens Replay where the work began; exporting
// that part of the recording waits in its menu. Until the proof is known, or without any, the same
// row opens the task in Replay when it can.
export function ProofStrip({
  api,
  sessionId,
  resultId,
  proof,
  onReplay,
}: {
  api: ApiClient;
  sessionId: string;
  resultId: string;
  proof: ProofState;
  onReplay?: () => void;
}) {
  const entry = proofOf(proof, resultId);
  if (!entry) return onReplay ? <ProofRow {...UNPROVEN} onPlay={onReplay} /> : null;
  // The recording covers the whole turn, screenshots or not; under a second there is nothing to see.
  const exportable =
    proof.state === "ready" &&
    EXPORTABLE.has(proof.proof.recording) &&
    entry.endMs - entry.startMs >= 1000;
  const end = entry.frames.find((frame) => frame.role === "end") ?? entry.frames.at(-1);
  const checked = entry.checked && markdownToPlain(entry.checked);
  const length = clock((entry.endMs - entry.startMs) / 1000);
  return (
    <ProofRow
      label={`Watch replay (${length})`}
      title={`Replay · ${length}`}
      poster={end && <ReplayImage api={api} sessionId={sessionId} frameId={end.frameId} />}
      detail={
        checked && (
          <span className="proof-checked" title={`Checked: ${checked}`}>
            <Icon name="check-circle" size={14} className="proof-checked-icon" />
            <span className="proof-checked-text">Checked: {checked}</span>
          </span>
        )
      }
      onPlay={() => openReplay(sessionId, { tMs: entry.startMs })}
      actions={
        exportable && (
          <RowMenu label="More for this replay">
            <MenuItem
              icon="share"
              onSelect={() =>
                openReplay(sessionId, {
                  tMs: entry.startMs,
                  exportRange: { fromMs: entry.startMs, toMs: entry.endMs },
                })
              }
            >
              Export proof video
            </MenuItem>
          </RowMenu>
        )
      }
    />
  );
}

// A result whose task is out of reach still opens it in Replay.
export function ReplayRow({ onReplay }: { onReplay(): void }) {
  return <ProofRow {...UNPROVEN} onPlay={onReplay} />;
}
