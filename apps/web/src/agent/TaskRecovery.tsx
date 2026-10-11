import { BudgetRaiseRequest, STALL } from "@localdot/protocol";
import { useState } from "react";
import { dollars } from "../copy/format.ts";
import { ownedPause } from "../session/status.ts";
import { Button } from "../ui/Button.tsx";
import { Collapse, Disclosure } from "../ui/Disclosure.tsx";
import { Field } from "../ui/Field.tsx";
import { Meter } from "../ui/Meter.tsx";
import { MoneyField } from "../ui/MoneyField.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import { resetTime } from "./UsageFooter.tsx";
import type { AgentSessionView } from "./useAgentSession.ts";
import type { TaskControls } from "./useTaskControls.ts";

const UNEXPLAINED =
  "The task could not continue. Check the reported reason and repair its provider or model before deciding whether to continue.";
export function recoveryMessage(reason: string | undefined, local: boolean): string {
  return knownReason(reason, local)?.text ?? UNEXPLAINED;
}
// A task keeps its model; another one takes a new task, and the conversation carries on.
const ANOTHER_MODEL =
  "pick another model in Settings, then stop this task and send your message again.";
function knownReason(
  reason: string | undefined,
  local: boolean,
): { title: string; text: string } | undefined {
  if (reason === STALL.budget)
    return {
      title: "I stopped at your spending limit",
      text: "I stopped at the spending limit. Raise it to continue; what was spent stays counted.",
    };
  if (reason === STALL.keyd)
    return {
      title: "I can't reach your keys",
      text: "dot can't reach your keys. Bring Keys back online, check the task, then continue.",
    };
  if (reason === STALL.providerLimit)
    return {
      title: "Your provider's credit or usage limit is reached",
      text: "Add credit or wait for your plan to reset, then continue. You can also choose another model and continue with it.",
    };
  if (reason === STALL.modelBusy)
    return {
      title: "The model is busy",
      text: "I'll try again by myself in a moment, or you can try now.",
    };
  if (reason === STALL.modelRefused)
    return {
      title: "The model turned down my request",
      text: `Try again, or ${ANOTHER_MODEL}`,
    };
  if (reason === STALL.keyReenter)
    return {
      title: "A key needs re-entering",
      text: "I can't use this key as it's stored. Enter it again in Keys, then continue. Its name and everything that uses it stay the same.",
    };
  if (reason === STALL.keyRebound)
    return {
      title: "A key was changed outside localDot",
      text: "Where this key is sent was changed outside localDot, so I won't use it. Remove it in Keys and add it again, then continue.",
    };
  if (reason === STALL.actionLimit)
    return {
      title: "I reached your action limit",
      text: "I stop after the number of actions you set in Settings. Continue when you're ready; the count starts again.",
    };
  if (reason === "chatgpt sign-in expired" || reason === "chatgpt account changed")
    return {
      title: "Sign in to ChatGPT again",
      text: "Repair the ChatGPT account in Settings, then continue this task.",
    };
  if (reason === "chatgpt plan limit reached")
    return {
      title: "Paused at your plan's limit",
      text: "Your ChatGPT plan is at its limit. Wait for it to reset, or choose another model and continue with it.",
    };
  if (reason === "claude code sign-in expired")
    return {
      title: "Sign in to Claude Code again",
      text: "Claude Code on this Mac isn't signed in. Run claude auth login in Terminal, then continue this task.",
    };
  if (reason === "claude code plan limit reached")
    return {
      title: "Paused at your plan's limit",
      text: "Your Claude plan is at its limit. Wait for it to reset, or choose another model and continue with it.",
    };
  if (reason === STALL.modelUnavailable)
    return {
      title: "The model isn't answering",
      text: local
        ? "The local model is unavailable. Start its server and load the chosen model, then continue."
        : `I tried several times. Try again now, or ${ANOTHER_MODEL}`,
    };
  return undefined;
}
// What a step adds to the limit. Two are offered: the smallest that covers what the next request
// needs, and the one after it.
const RAISES = [2, 5, 10, 25, 50] as const;
export function raiseSteps(need: number | undefined): number[] {
  const first = RAISES.findIndex((raise) => raise >= (need ?? 5));
  const at = first < 0 ? RAISES.length - 2 : Math.min(first, RAISES.length - 2);
  return RAISES.slice(at, at + 2);
}
// Why the limit stopped dot: the next request may need more than is left, or nothing is left. A
// task's own limit is raised here; the daily one says where it is changed.
export function spendingText(data: {
  scope: "task" | "day";
  limitUSD: number;
  spentUSD: number;
  needUSD?: number;
}): string {
  const limit = data.scope === "day" ? "today's limit" : "this task's limit";
  const left = Math.round(Math.max(0, data.limitUSD - data.spentUSD) * 100) / 100;
  const why =
    data.needUSD && left > 0
      ? `dot's next step could cost up to ${dollars(data.needUSD)}, and ${dollars(left)} of ${limit} is left.`
      : `dot has spent all of ${limit}.`;
  return data.scope === "day"
    ? why
    : `${why} Raise the limit to continue; what was spent stays counted.`;
}
// The daily limit belongs to the key layer and is shared by every task, so no raise here moves it.
const DAY_LIMIT =
  "Today's spending limit is used up. All tasks share it, and it resets at midnight.";
const CUSTOM = "other";
const MAX_LIMIT = 10_000;

export function raiseChoice(choice: string, custom: string, limitUSD: number): number | string {
  const value = choice === CUSTOM ? Number(custom) : limitUSD + Number(choice);
  if (
    choice === CUSTOM &&
    (!custom ||
      !Number.isFinite(value) ||
      value <= limitUSD ||
      !BudgetRaiseRequest.safeParse({ budgetUSD: value }).success)
  )
    return `Enter a limit above ${dollars(limitUSD)}, up to ${dollars(MAX_LIMIT)}.`;
  return Math.round(value * 100) / 100;
}

// Reasons whose one fix is to try the model again, with another model as the way out.
const RETRY = new Set<string | undefined>([
  STALL.modelBusy,
  STALL.modelRefused,
  STALL.modelUnavailable,
]);

export function TaskRecovery({
  agent,
  controls,
  onSettings,
  onReenterKey,
  onContinue,
  onCarryOn,
  onResumeSelected,
  resumeBlocked,
}: {
  agent: AgentSessionView;
  controls: TaskControls;
  onSettings(trigger: HTMLButtonElement, section?: "models" | "keys"): void;
  // Opens Keys at the form that stores this key's value again.
  onReenterKey?(trigger: HTMLButtonElement, id: string): void;
  // Sends a follow-up that carries on a task the user's action limit stopped.
  onContinue?(): Promise<boolean>;
  // Starts the conversation's next task to carry on one that was interrupted; left out while the
  // computer can't take a task.
  onCarryOn?(): Promise<boolean>;
  onResumeSelected?(): Promise<boolean>;
  resumeBlocked?: string;
}) {
  const budget = agent.model.budget;
  const need = budget?.data.needUSD;
  const steps = raiseSteps(need);
  // A choice belongs to the refusal it was made for; a new one starts from its own first step.
  const [chosen, setChosen] = useState<{ budget: string | undefined; value: string } | null>(null);
  const choice = chosen && chosen.budget === budget?.id ? chosen.value : String(steps[0]);
  const [custom, setCustom] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [continuing, setContinuing] = useState(false);
  const state = agent.model.state;
  const send = (run: () => Promise<boolean>) => {
    if (continuing) return;
    setContinuing(true);
    void run().then((sent) => {
      setContinuing(false);
      setProblem(sent ? null : "That didn't go through. Try again.");
    });
  };
  if (agent.interrupted && !controls.fenced)
    return (
      <section className="thread-recovery" aria-label="Task recovery">
        <h3 className="thread-recovery-title">I was cut off before I finished</h3>
        <p className="thread-recovery-text">
          localDot restarted while I was working. Continue, and I'll pick up where I left off.
        </p>
        <div className="thread-recovery-actions">
          <Button
            variant="primary"
            icon="continue"
            busy={continuing}
            disabledReason={onCarryOn ? undefined : "Turn on your computer first"}
            onClick={() => onCarryOn && send(onCarryOn)}
          >
            Continue
          </Button>
        </div>
        {problem && (
          <p className="thread-recovery-reason" role="alert">
            {problem}
          </p>
        )}
      </section>
    );
  // While a Pause holds the task, only a spending limit that still holds it needs this panel.
  const hold = agent.snapshot?.pause ? agent.snapshot.budgetHold : undefined;
  const limited = state?.state === "idle" && state.reason === STALL.actionLimit;
  if (
    controls.fenced ||
    (agent.snapshot?.pause && !hold) ||
    !agent.sessionId ||
    agent.model.ended ||
    !state ||
    // A restart after the brain stopped says so on the HUD and needs nothing from the user.
    (state.state === "error" && /restarting/.test(state.reason ?? "")) ||
    (!hold &&
      !limited &&
      (!["paused", "error"].includes(state.state) ||
        (state.state === "paused" && ownedPause(state.reason))))
  )
    return null;
  const subscription =
    agent.snapshot?.models?.kind === "chatgpt" ||
    agent.snapshot?.models?.kind === "claude-code" ||
    !!agent.model.subscription;
  const local =
    agent.snapshot?.models?.kind === "api" &&
    agent.snapshot.models.roles.some(
      (role) => role.role === "main" && ["ollama", "lmstudio"].includes(role.provider),
    );
  // A held Pause stands in for the paused state the spending limit published.
  const reason = hold ? "budget" : state.reason;
  const known = knownReason(reason, local);
  const taskBudget =
    !subscription &&
    budget?.data.scope === "task" &&
    budget.data.taskId === agent.sessionId &&
    (hold ? hold === "task" : state.state === "paused");
  const dayLimit = hold ? hold === "day" : reason === "budget" && budget?.data.scope === "day";
  const raising = taskBudget && budget;
  const raised = raising ? raiseChoice(choice, custom, budget.data.limitUSD) : null;
  const resets = subscription
    ? resetTime(
        agent.model.subscription?.data.windows
          .filter(
            (window) => window.usedPercent >= 100 || agent.model.subscription?.data.limitReached,
          )
          .map((window) => window.resetsAt)
          .filter((at): at is number => at !== undefined)
          .sort((a, b) => b - a)[0],
      )
    : null;
  const retry = RETRY.has(reason);
  const providerLimited =
    reason === STALL.providerLimit ||
    reason === "chatgpt plan limit reached" ||
    reason === "claude code plan limit reached";
  // The key to enter again, or to remove and add again, when keyd named one.
  const reentry = !hold && reason === STALL.keyReenter ? (state.detail ?? "") : undefined;
  const changed = !hold && reason === STALL.keyRebound ? (state.detail ?? "") : undefined;
  const resume = limited ? (
    <Button
      variant="primary"
      busy={continuing}
      disabledReason={onContinue ? undefined : "The task can't continue right now."}
      onClick={() => onContinue && send(onContinue)}
    >
      Continue
    </Button>
  ) : (
    <Button
      variant={raising || reentry !== undefined || changed !== undefined ? "secondary" : "primary"}
      disabledReason={
        resumeBlocked ?? (controls.canResumeTask ? undefined : "The task can't continue right now.")
      }
      busy={continuing}
      onClick={() => send(onResumeSelected ?? controls.resume)}
    >
      {raising ? "Continue without raising" : retry ? "Retry now" : "Continue"}
    </Button>
  );
  return (
    <section className="thread-recovery" aria-label="Task recovery">
      <h3 className="thread-recovery-title">
        {reentry
          ? `Re-enter your ${reentry} key`
          : changed
            ? `Your ${changed} key was changed outside localDot`
            : (known?.title ??
              (hold || state.state === "paused" ? "Task paused" : "The task needs attention"))}
      </h3>
      <p className="thread-recovery-text">
        {dayLimit
          ? DAY_LIMIT
          : reason === "budget" && budget && !subscription
            ? spendingText(budget.data)
            : (known?.text ?? UNEXPLAINED)}
      </p>
      {reason && !known && <p className="thread-recovery-reason">Reported reason: {reason}</p>}
      {state.detail && !reentry && !changed && (
        <p className="thread-recovery-reason">The model said: {state.detail}</p>
      )}
      {resets && (
        <p className="thread-recovery-reason">
          {resets.replace(/^Resets/, "Your plan's limit resets")}.
        </p>
      )}
      {!subscription && budget && reason === STALL.budget && (
        <div className="thread-recovery-meter">
          <p className="num">
            {dollars(budget.data.spentUSD)} of {dollars(budget.data.limitUSD)} spent
            {budget.data.scope === "day" ? " today" : ""}
          </p>
          <Meter
            value={budget.data.spentUSD}
            max={budget.data.limitUSD}
            label={
              budget.data.scope === "day" ? "Spent of today's limit" : "Spent of this task's limit"
            }
          />
        </div>
      )}
      {raising ? (
        <form
          className="thread-recovery-raise"
          aria-label="Raise the spending limit"
          onSubmit={(event) => {
            event.preventDefault();
            if (typeof raised !== "number") {
              setProblem(raised);
              return;
            }
            setProblem(null);
            if (controls.canRaiseBudget) void controls.raiseBudget(raised);
          }}
        >
          <SegmentedControl
            aria-label="Raise the limit by"
            items={[
              ...steps.map((raise) => ({ value: String(raise), label: `+$${raise}` })),
              { value: CUSTOM, label: "Other" },
            ]}
            value={choice}
            onValueChange={(value) => {
              setChosen({ budget: budget.id, value });
              setProblem(null);
            }}
          />
          <Collapse open={choice === CUSTOM} className="thread-recovery-custom">
            <Field label="New limit" error={problem}>
              <MoneyField
                placeholder={String(budget.data.limitUSD + 5)}
                value={custom}
                onValueChange={(value) => {
                  setCustom(value);
                  setProblem(null);
                }}
              />
            </Field>
          </Collapse>
          <div className="thread-recovery-actions">
            <Button
              type="submit"
              variant="primary"
              disabledReason={
                controls.canRaiseBudget ? undefined : "The limit can't be raised right now."
              }
            >
              {typeof raised === "number"
                ? `Raise to ${dollars(raised)}${hold ? "" : " and continue"}`
                : hold
                  ? "Raise the limit"
                  : "Raise and continue"}
            </Button>
          </div>
        </form>
      ) : (
        !hold && (
          <div className="thread-recovery-actions">
            {reentry !== undefined && (
              <Button
                variant="primary"
                icon="key-round"
                onClick={(event) =>
                  reentry && onReenterKey
                    ? onReenterKey(event.currentTarget, reentry)
                    : onSettings(event.currentTarget, "keys")
                }
              >
                Re-enter key
              </Button>
            )}
            {changed !== undefined && (
              <Button
                variant="primary"
                icon="key-round"
                onClick={(event) => onSettings(event.currentTarget, "keys")}
              >
                Open Keys
              </Button>
            )}
            {resume}
            {(retry || providerLimited) && reason !== STALL.modelBusy && (
              <Button
                variant="secondary"
                onClick={(event) => onSettings(event.currentTarget, "models")}
              >
                Change model
              </Button>
            )}
          </div>
        )
      )}
      {problem && !raising && (
        <p className="thread-recovery-reason" role="alert">
          {problem}
        </p>
      )}
      {hold && (
        <p className="thread-recovery-reason">The task stays paused until you press Continue.</p>
      )}
      <Disclosure summary="Recovery options" className="thread-recovery-options">
        <div className="thread-recovery-actions">
          {raising && !hold && resume}
          <Button variant="quiet" onClick={(event) => onSettings(event.currentTarget)}>
            Open Settings
          </Button>
          <Button variant="quiet" onClick={controls.recheck}>
            Check task state
          </Button>
        </div>
        <p className="thread-note">
          {onResumeSelected
            ? "Continue starts the next task with your selected model and the conversation so far."
            : "Continuing keeps this task's model and its spending limit."}
        </p>
      </Disclosure>
    </section>
  );
}
