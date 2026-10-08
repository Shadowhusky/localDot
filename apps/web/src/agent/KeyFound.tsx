import { CLAUDE_PLAN_REFUSAL } from "@localdot/protocol";
import { useState } from "react";
import type { KeyIntake } from "../keys/KeyForm.tsx";
import type { KeyGuard, KeyNotice } from "./useKeyGuard.ts";
import "./key-guard.css";

export function KeyFound({
  guard,
  receive,
  noticeId,
}: {
  guard: KeyGuard;
  receive?: KeyIntake["receive"];
  noticeId?: string;
}) {
  const [choice, setChoice] = useState<{ notice: KeyNotice | null; index: number }>({
    notice: null,
    index: 0,
  });
  const notice = guard.notice;
  if (!notice) return null;
  const count = notice.candidates.length;
  const index = choice.notice === notice ? Math.min(choice.index, Math.max(0, count - 1)) : 0;
  const planToken = notice.candidates[index]?.hint === "Claude plan token";
  const onlyPlanTokens =
    count > 0 && notice.candidates.every((candidate) => candidate.hint === "Claude plan token");
  const choosing = count > 1 && !onlyPlanTokens;
  return (
    <section className="key-found" aria-label="Key safeguard">
      <p role="alert" id={noticeId}>
        {notice.kind === "overflow"
          ? "This text exceeded the key safeguard's limit and was cleared. Paste keys directly into Keys."
          : notice.kind === "transfer_failed"
            ? "Could not move the key. Open Keys and paste it again."
            : onlyPlanTokens
              ? count === 1
                ? "A Claude plan token was removed from your message."
                : `${count} Claude plan tokens were removed from your message.`
              : count === 1
                ? "1 recognised key was removed from your message. Discard it or move it to Keys before sending."
                : `${count} recognised keys were removed from your message. Discard them or move one to Keys before sending.`}
      </p>
      {choosing && (
        <label>
          <span>Key to move</span>
          <select
            value={index}
            onChange={(event) => setChoice({ notice, index: Number(event.target.value) })}
          >
            {notice.candidates.map((candidate, i) => (
              <option key={`${candidate.start}-${candidate.end}`} value={i}>
                {candidate.hint} · character {candidate.start + 1}
              </option>
            ))}
          </select>
        </label>
      )}
      {planToken && <p>{CLAUDE_PLAN_REFUSAL}</p>}
      {choosing && <p>Moving one key discards the other detected keys.</p>}
      <div className="key-found-actions">
        <button type="button" onClick={guard.remove}>
          {notice.kind !== "found"
            ? "Edit message"
            : notice.candidates.length === 1
              ? "Discard key and edit"
              : "Discard keys and edit"}
        </button>
        {notice.kind === "found" && !planToken && (
          <button
            type="button"
            disabled={!receive}
            onClick={() => {
              if (receive) guard.move(index, receive);
            }}
          >
            Move to Keys
          </button>
        )}
      </div>
      {!receive && notice.kind === "found" && !planToken && (
        <p>Open Keys to store a key securely.</p>
      )}
    </section>
  );
}
