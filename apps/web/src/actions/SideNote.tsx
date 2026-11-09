import type { PlanProvider, PlanUsageReply } from "@localdot/protocol";
import type { ReactNode } from "react";
import { PlanUsageList } from "../agent/PlanUsage.tsx";
import { SafeMarkdown } from "../agent/SafeMarkdown.tsx";
import { count, spendText } from "../copy/format.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Spinner } from "../ui/Spinner.tsx";
import type { SideAnswer, SideStep } from "./side-question.ts";
import type { Aside } from "./useAside.ts";
import "../ui/command-menu.css";

const STEPS_SHOWN = 4;
const address = (href: string) => {
  try {
    return new URL(href).href.replace(/#.*$/, "");
  } catch {
    return href;
  }
};
// An answer opens only the addresses the user wrote or its own searches found: any other may carry
// what it read to whoever made it up.
const opensOnly = (links: readonly string[] | undefined) => {
  const open = new Set((links ?? []).map(address));
  return (href: string) => open.has(address(href));
};
const opensNone = () => false;
const SOURCE_WORDS: Record<string, string> = {
  record: "what was said in the task",
  log: "the task's log",
  terminal: "the terminal output",
  screen: "the screen",
  file: "a file on the computer",
  deliverable: "the files dot handed over",
  earlier: "earlier conversations",
  web: "the web",
};
const ENDED: Record<NonNullable<SideAnswer["ended"]>, string> = {
  time: "It stopped at a side question's time limit, with what it had found.",
  cost: "It stopped at a side question's cost limit, with what it had found.",
  "no-main": "There's no other model to ask, so this is as far as it got.",
};

function sourcesText(sources: readonly string[] | undefined): string | undefined {
  const words = [...new Set(sources ?? [])].flatMap((source) => SOURCE_WORDS[source] ?? []);
  if (!words.length) return undefined;
  const last = words.at(-1);
  return `From ${words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${last}` : last}.`;
}

function spentLine(spend: SideAnswer["spend"]): string | undefined {
  if (!spend) return undefined;
  if (spend.plan && !spend.usd)
    return `Used ${count(spend.inputTokens + spend.outputTokens, "token", "tokens")} of your plan.`;
  if (!spend.usd) return undefined;
  const earlier = spend.taskUSD - spend.usd > 0.0005;
  return `Cost ${spendText(spend.usd, true)}${earlier ? `, ${spendText(spend.taskUSD, true)} for this task's side questions so far` : ""}. Not counted in the task's budget.`;
}

// What it has done so far: the newest line is what it's doing now, and what the first model found
// shows while the next one looks further.
function Steps({
  steps,
  modelName,
}: {
  steps: readonly SideStep[];
  modelName(provider: string, model: string): string;
}) {
  const line = (step: SideStep) =>
    "progress" in step
      ? step.progress
      : `Asking ${modelName(step.handover.provider, step.handover.model)}…`;
  const partial = steps.flatMap((step) => ("partial" in step && step.partial ? step.partial : []));
  // Steps only ever join the end, so where each stands names it.
  const shown = steps.map((step, at) => ({ step, at })).slice(-STEPS_SHOWN);
  const current = shown.at(-1)?.step;
  return (
    <>
      {partial.length > 0 && (
        <div className="side-note-partial">
          <span className="side-note-by">So far</span>
          <SafeMarkdown text={partial.at(-1) ?? ""} compact links={opensNone} />
        </div>
      )}
      <ul className="side-note-steps">
        {shown.slice(0, -1).map(({ step, at }) => (
          <li key={at} className="side-note-by">
            <Icon name="check" size={12} />
            {line(step)}
          </li>
        ))}
      </ul>
      <p className="side-note-wait" role="status">
        <Spinner size={16} />
        {current ? line(current) : "Asking…"}
      </p>
    </>
  );
}

// A side question's answer, or the plans' usage, at the end of the thread for the user alone.
export function SideNote({
  aside,
  plans,
  usage,
  modelName,
  onDismiss,
  onRetry,
  onStop,
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
  onStop(): void;
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
  const answer = aside.answer;
  const from = sourcesText(answer?.sources);
  const spent = spentLine(answer?.spend);
  return head(
    "Side question",
    <>
      <p className="side-note-question">{aside.question}</p>
      {aside.phase === "asking" && (
        <>
          <Steps steps={aside.steps ?? []} modelName={modelName} />
          <div className="side-note-actions">
            <Button size="sm" onClick={onStop}>
              Stop
            </Button>
          </div>
        </>
      )}
      {aside.phase === "answered" && answer && (
        <>
          <div className="side-note-answer">
            <SafeMarkdown text={answer.answer} compact links={opensOnly(answer.links)} />
          </div>
          {from && <p className="side-note-by">{from}</p>}
          {answer.ended && <p className="side-note-by">{ENDED[answer.ended]}</p>}
          <p className="side-note-by">
            {`Answered by ${modelName(answer.provider, answer.model)}`}
            {answer.handedOver &&
              `, after ${modelName(answer.handedOver.provider, answer.handedOver.model)} couldn't find it`}
            {answer.failed &&
              `, as ${modelName(answer.provider, answer.failed.model)} didn't: ${answer.failed.reason}`}
          </p>
          {spent && <p className="side-note-by">{spent}</p>}
        </>
      )}
      {aside.phase === "stopped" && (
        <>
          <p className="side-note-by" role="status">
            Stopped.
          </p>
          <div className="side-note-actions">
            <Button size="sm" onClick={onRetry}>
              Ask again
            </Button>
          </div>
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
                Choose a model
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
