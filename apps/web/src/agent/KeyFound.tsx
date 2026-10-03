import { useState } from "react";
import type { KeyIntake } from "../keys/KeyForm.tsx";
import type { KeyGuard } from "./useKeyGuard.ts";
import "./key-guard.css";

export function KeyFound({ guard, receive }: { guard: KeyGuard; receive?: KeyIntake["receive"] }) {
  const [selected, setSelected] = useState(0);
  const notice = guard.notice;
  if (!notice) return null;
  const index = Math.min(selected, Math.max(0, notice.candidates.length - 1));
  return (
    <section className="key-found" aria-label="Key safeguard">
      <p role="alert">
        {notice.kind === "overflow"
          ? "This text exceeded the key safeguard's limit and was cleared. Paste keys directly into Keys."
          : notice.kind === "transfer_failed"
            ? "Could not move the key. Open Keys and paste it again."
            : `${notice.candidates.length} recognised ${notice.candidates.length === 1 ? "key was" : "keys were"} removed from your message. Review the remaining text before sending.`}
      </p>
      {notice.candidates.length > 1 && (
        <label>
          <span>Key to move</span>
          <select value={index} onChange={(event) => setSelected(Number(event.target.value))}>
            {notice.candidates.map((candidate, i) => (
              <option key={`${candidate.start}-${candidate.end}`} value={i}>
                {candidate.hint} · character {candidate.start + 1}
              </option>
            ))}
          </select>
        </label>
      )}
      {notice.candidates.length > 1 && <p>Moving one key discards the other detected keys.</p>}
      <div className="key-found-actions">
        <button type="button" onClick={guard.edit}>
          Edit message
        </button>
        <button type="button" onClick={guard.remove}>
          {notice.kind === "found" ? "Discard detected keys" : "Review message"}
        </button>
        {notice.kind === "found" && (
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
      {!receive && notice.kind === "found" && <p>Open Keys to store a key securely.</p>}
    </section>
  );
}
