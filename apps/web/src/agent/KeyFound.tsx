import { CLAUDE_PLAN_REFUSAL } from "@localdot/protocol";
import { clsx } from "clsx";
import { useRef, useState } from "react";
import { t } from "../i18n/index.ts";
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
      ? t`Message cleared`
      : notice.kind === "transfer_failed"
        ? t`Key not moved`
        : onlyPlanTokens
          ? count === 1
            ? t`Claude plan token removed`
            : t`Claude plan tokens removed`
          : count === 1
            ? t`Key removed before sending`
            : t`Keys removed before sending`;
  const taken =
    count === 1
      ? within === "message"
        ? t`A key in your message was taken out before anything was sent. Move it to Keys to keep it safe, or discard it.`
        : t`A key in your answer was taken out before anything was sent. Move it to Keys to keep it safe, or discard it.`
      : within === "message"
        ? t`${count} keys in your message were taken out before anything was sent. Move one to Keys, or discard them.`
        : t`${count} keys in your answer were taken out before anything was sent. Move one to Keys, or discard them.`;
  return (
    <section
      className={clsx("key-found", className)}
      aria-label={open ? t`Key safeguard` : undefined}
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
                  disabledReason={receive ? undefined : t`Open Keys to store a key safely.`}
                  onClick={() => {
                    if (receive) guard.move(index, receive);
                  }}
                >
                  {t`Move to Keys`}
                </Button>
              )}
              <Button size="sm" onClick={guard.remove}>
                {!found ? t`Edit message` : count === 1 ? t`Discard key` : t`Discard keys`}
              </Button>
            </>
          )
        }
      >
        {notice && (
          <div className="key-found-text" role={open ? "alert" : undefined} id={noticeId}>
            <p>
              {notice.kind === "overflow"
                ? t`It was too long to check for keys. Paste keys straight into Keys.`
                : notice.kind === "transfer_failed"
                  ? t`Open Keys and paste it again.`
                  : onlyPlanTokens
                    ? CLAUDE_PLAN_REFUSAL
                    : taken}
            </p>
            {choosing && planToken && <p>{CLAUDE_PLAN_REFUSAL}</p>}
          </div>
        )}
        {notice && choosing && (
          <div className="key-found-choice">
            <Select
              aria-label={t`Key to move`}
              value={String(index)}
              onValueChange={(value) => setChoice({ notice, index: Number(value) })}
              items={notice.candidates.map((candidate, i) => ({
                value: String(i),
                label: t`${candidate.hint} · character ${candidate.start + 1}`,
              }))}
            />
            <p>{t`Moving one key discards the others.`}</p>
          </div>
        )}
      </Banner>
    </section>
  );
}
