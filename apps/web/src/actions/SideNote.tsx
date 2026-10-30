import type { PlanProvider, PlanUsageReply } from "@localdot/protocol";
import type { ReactNode } from "react";
import { PlanUsageList } from "../agent/PlanUsage.tsx";
import { SafeMarkdown } from "../agent/SafeMarkdown.tsx";
import { Button } from "../ui/Button.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Spinner } from "../ui/Spinner.tsx";
import type { Aside } from "./useAside.ts";
import "../ui/command-menu.css";

// A side question's answer, or the plans' usage, at the end of the thread for the user alone.
export function SideNote({
  aside,
  plans,
  usage,
  modelName,
  onDismiss,
  onRetry,
  onModels,
  onSpending,
}: {
  aside: Aside;
  // The subscription plans in use, whose usage /usage shows.
  plans: readonly PlanProvider[];
  usage: PlanUsageReply | null;
  modelName(provider: string, model: string): string;
  onDismiss(): void;
  onRetry(): void;
  onModels(trigger: HTMLElement): void;
  onSpending(trigger: HTMLElement): void;
}) {
  const head = (title: string, body: ReactNode) => (
    <section className="side-note" aria-label={title} data-aside={aside.kind}>
      <div className="side-note-head">
        <span className="side-note-title">
          {title}
          <span className="side-note-private">Only you see this. dot doesn't.</span>
        </span>
        <IconButton icon="x" size={24} label={`Close ${title.toLowerCase()}`} onClick={onDismiss} />
      </div>
      {body}
    </section>
  );
  if (aside.kind === "usage")
    return head(
      "Plan usage",
      plans.length && usage ? (
        <PlanUsageList reply={usage} providers={plans} />
      ) : (
        <>
          <p className="side-note-problem">
            {plans.length
              ? "Usage appears once a plan has answered."
              : "Usage limits are for the ChatGPT and Claude Code plans. What API keys cost is in Spending."}
          </p>
          {!plans.length && (
            <div className="side-note-actions">
              <Button size="sm" onClick={(event) => onSpending(event.currentTarget)}>
                Open Spending
              </Button>
            </div>
          )}
        </>
      ),
    );
  return head(
    "Side question",
    <>
      <p className="side-note-question">{aside.question}</p>
      {aside.phase === "asking" && (
        <p className="side-note-wait" role="status">
          <Spinner size={16} />
          Asking your Fast model…
        </p>
      )}
      {aside.phase === "answered" && aside.answer && (
        <>
          <div className="side-note-answer">
            <SafeMarkdown text={aside.answer.answer} compact />
          </div>
          <p className="side-note-by">
            {`Answered by ${modelName(aside.answer.provider, aside.answer.model)}, your Fast model`}
          </p>
        </>
      )}
      {aside.phase === "failed" && (
        <>
          <p className="side-note-problem" role="alert">
            {aside.problem}
          </p>
          <div className="side-note-actions">
            {aside.setup ? (
              <Button size="sm" onClick={(event) => onModels(event.currentTarget)}>
                Choose a Fast model
              </Button>
            ) : (
              <Button size="sm" onClick={onRetry}>
                Try again
              </Button>
            )}
          </div>
        </>
      )}
    </>,
  );
}
