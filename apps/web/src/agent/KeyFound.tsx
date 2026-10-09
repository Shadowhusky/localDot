import { CLAUDE_PLAN_REFUSAL } from "@localdot/protocol";
import { clsx } from "clsx";
import { useRef, useState } from "react";
import type { KeyIntake } from "../keys/KeyForm.tsx";
import { Banner } from "../ui/Banner.tsx";
import { Button } from "../ui/Button.tsx";
import { Select } from "../ui/Select.tsx";
import type { KeyGuard, KeyNotice } from "./useKeyGuard.ts";

const PLAN = "Claude plan token";

// Shown over the field a key was taken out of. It stays mounted, so it opens and closes in place,
// and keeps the last notice's words while it folds away.
export function KeyFound({
  guard,
  receive,
  noticeId,
  className,
  within = "message",
}: {
  guard: Pick<KeyGuard, "notice" | "move" | "remove">;
  receive?: KeyIntake["receive"];
  noticeId?: string;
  className?: string;
  // What the key was typed into, as the notice names it.
  within?: "message" | "answer";
}) {
  const [choice, setChoice] = useState<{ notice: KeyNotice | null; index: number }>({
    notice: null,
    index: 0,
  });
  const last = useRef<KeyNotice | null>(null);
  if (guard.notice) last.current = guard.notice;
  const open = guard.notice !== null;
  const notice = guard.notice ?? last.current;
  const count = notice?.candidates.length ?? 0;
  const index = choice.notice === notice ? Math.min(choice.index, Math.max(0, count - 1)) : 0;
  const planToken = notice?.candidates[index]?.hint === PLAN;
  const onlyPlanTokens =
    count > 0 && notice?.candidates.every((candidate) => candidate.hint === PLAN);
  const choosing = count > 1 && !onlyPlanTokens;
  const found = notice?.kind === "found";
  const title = !notice
    ? ""
    : notice.kind === "overflow"
      ? "Message cleared"
      : notice.kind === "transfer_failed"
        ? "Key not moved"
        : onlyPlanTokens
          ? count === 1
            ? "Claude plan token removed"
            : "Claude plan tokens removed"
          : count === 1
            ? "Key removed before sending"
            : "Keys removed before sending";
  return (
    <section
      className={clsx("key-found", className)}
      aria-label={open ? "Key safeguard" : undefined}
      aria-hidden={open ? undefined : true}
    >
      <Banner
        open={open}
        tone="attention"
        icon="lock"
        title={title}
        actions={
          notice && (
            <>
              {found && !planToken && (
                <Button
                  size="sm"
                  variant="primary"
                  disabledReason={receive ? undefined : "Open Keys to store a key safely."}
                  onClick={() => {
                    if (receive) guard.move(index, receive);
                  }}
                >
                  Move to Keys
                </Button>
              )}
              <Button size="sm" onClick={guard.remove}>
                {!found ? "Edit message" : count === 1 ? "Discard key" : "Discard keys"}
              </Button>
            </>
          )
        }
      >
        {notice && (
          <div className="key-found-text" role={open ? "alert" : undefined} id={noticeId}>
            <p>
              {notice.kind === "overflow"
                ? "It was too long to check for keys. Paste keys straight into Keys."
                : notice.kind === "transfer_failed"
                  ? "Open Keys and paste it again."
                  : onlyPlanTokens
                    ? CLAUDE_PLAN_REFUSAL
                    : count === 1
                      ? `A key in your ${within} was taken out before anything was sent. Move it to Keys to keep it safe, or discard it.`
                      : `${count} keys in your ${within} were taken out before anything was sent. Move one to Keys, or discard them.`}
            </p>
            {choosing && planToken && <p>{CLAUDE_PLAN_REFUSAL}</p>}
          </div>
        )}
        {notice && choosing && (
          <div className="key-found-choice">
            <Select
              aria-label="Key to move"
              value={String(index)}
              onValueChange={(value) => setChoice({ notice, index: Number(value) })}
              items={notice.candidates.map((candidate, i) => ({
                value: String(i),
                label: `${candidate.hint} · character ${candidate.start + 1}`,
              }))}
            />
            <p>Moving one key discards the others.</p>
          </div>
        )}
      </Banner>
    </section>
  );
}
