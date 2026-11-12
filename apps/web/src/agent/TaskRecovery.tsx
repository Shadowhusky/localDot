import { BudgetRaiseRequest, refusalAdvice, STALL } from "@localdot/protocol";
import { useEffect, useRef, useState } from "react";
import { dollars } from "../copy/format.ts";
import { t, tr } from "../i18n/index.ts";
import { ownedPause } from "../session/status.ts";
import type { ReportAbout } from "../settings/reports-api.ts";
import type { SettingsTip } from "../settings/settings-link.ts";
import { Button } from "../ui/Button.tsx";
import { Collapse, Disclosure } from "../ui/Disclosure.tsx";
import { Field } from "../ui/Field.tsx";
import type { IconName } from "../ui/icons.ts";
import { Meter } from "../ui/Meter.tsx";
import { MoneyField } from "../ui/MoneyField.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import { planWait } from "./FixCards.tsx";
import { resetWhen } from "./UsageFooter.tsx";
import type { AgentSessionView } from "./useAgentSession.ts";
import type { TaskControls } from "./useTaskControls.ts";

const UNEXPLAINED = t`The task could not continue. Check the reported reason and repair its provider or model before deciding whether to continue.`;
export function recoveryMessage(reason: string | undefined, local: boolean): string {
  return knownReason(reason, local)?.text ?? UNEXPLAINED;
}
// A task keeps its model; another one takes a new task, and the conversation carries on.
function knownReason(
  reason: string | undefined,
  local: boolean,
  detail?: string,
): { title: string; text: string } | undefined {
  if (reason === STALL.budget)
    return {
      title: t`I stopped at your spending limit`,
      text: t`I stopped at the spending limit. Raise it to continue; what was spent stays counted.`,
    };
  if (reason === STALL.keyd)
    return {
      title: t`I can't reach your keys`,
      text: t`dot can't reach your keys. Bring Keys back online, check the task, then continue.`,
    };
  if (reason === STALL.providerLimit)
    return {
      title: t`Your provider's credit or usage limit is reached`,
      text: t`Add credit or wait for your plan to reset, then continue. You can also choose another model and continue with it.`,
    };
  if (reason === STALL.modelBusy)
    return {
      title: t`The model is busy`,
      text: t`I'll try again by myself in a moment, or you can try now.`,
    };
  if (reason === STALL.modelRefused)
    return {
      title: t`The provider could not process my request`,
      text: t`${refusalAdvice(detail)}, then try again, or pick another model in Settings, then stop this task and send your message again.`,
    };
  if (reason === STALL.keyReenter)
    return {
      title: t`A key needs re-entering`,
      text: t`I can't use this key as it's stored. Enter it again in Keys, then continue. Its name and everything that uses it stay the same.`,
    };
  if (reason === STALL.keyRebound)
    return {
      title: t`A key was changed outside localDot`,
      text: t`Where this key is sent was changed outside localDot, so I won't use it. Remove it in Keys and add it again, then continue.`,
    };
  if (reason === STALL.actionLimit)
    return {
      title: t`I reached your action limit`,
      text: t`I stop after the number of actions you set in Settings. Continue when you're ready; the count starts again.`,
    };
  if (reason === "chatgpt sign-in expired" || reason === "chatgpt account changed")
    return {
      title: t`Sign in to ChatGPT again`,
      text: t`Sign in to your ChatGPT account again, then continue this task.`,
    };
  if (reason === "chatgpt plan limit reached")
    return {
      title: t`Paused at your plan's limit`,
      text: t`Your ChatGPT plan is at its limit. Wait for it to reset, or choose another model and continue with it.`,
    };
  if (reason === "claude code sign-in expired")
    return {
      title: t`Sign in to Claude Code again`,
      text: t`Claude Code on this Mac isn't signed in. Run claude auth login in Terminal (its setup shows the command too), then continue this task.`,
    };
  if (reason === STALL.fixedElsewhere)
    return {
      title: t`That's fixed now`,
      text: t`It was fixed outside this task, so I stayed stopped. Continue, and I'll pick up where I stopped.`,
    };
  if (reason === STALL.keysLocked)
    return {
      title: t`Your saved keys are unlocked`,
      text: t`Continue, and I'll pick up where I stopped.`,
    };
  if (reason === "claude code plan limit reached")
    return {
      title: t`Paused at your plan's limit`,
      text: t`Your Claude plan is at its limit. Wait for it to reset, or choose another model and continue with it.`,
    };
  if (reason === STALL.modelUnavailable)
    return {
      title: t`The model isn't answering`,
      text: local
        ? t`The local model is unavailable. Start its server and load the chosen model, then continue.`
        : t`I tried several times. Try again now, or pick another model in Settings, then stop this task and send your message again.`,
    };
  return undefined;
}
// The one place that unblocks a reason, opened with what to do there lit up.
const FIXES: Record<
  string,
  { label: string; icon?: IconName; section: "models" | "keys"; tip?: SettingsTip }
> = {
  "chatgpt sign-in expired": {
    label: tr("Sign in to ChatGPT"),
    section: "models",
    tip: "models-chatgpt",
  },
  "chatgpt account changed": {
    label: tr("Sign in to ChatGPT"),
    section: "models",
    tip: "models-chatgpt",
  },
  "claude code sign-in expired": {
    label: tr("Open Claude Code setup"),
    section: "models",
    tip: "models-claude-code",
  },
  [STALL.keyd]: {
    label: tr("Open Keys"),
    icon: "key-round",
    section: "keys",
    tip: "keys-protection",
  },
  [STALL.keyRebound]: { label: tr("Open Keys"), icon: "key-round", section: "keys" },
};
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
  const left = Math.round(Math.max(0, data.limitUSD - data.spentUSD) * 100) / 100;
  if (data.needUSD && left > 0) {
    const need = dollars(data.needUSD);
    return data.scope === "day"
      ? t`dot's next step could cost up to ${need}, and ${dollars(left)} of today's limit is left.`
      : t`dot's next step could cost up to ${need}, and ${dollars(left)} of this task's limit is left. Raise the limit to continue; what was spent stays counted.`;
  }
  return data.scope === "day"
    ? t`dot has spent all of today's limit.`
    : t`dot has spent all of this task's limit. Raise the limit to continue; what was spent stays counted.`;
}
// The daily limit belongs to the key layer and is shared by every task, so no raise here moves it.
const DAY_LIMIT = t`Today's spending limit is used up. All tasks share it, and it resets at midnight.`;
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
    return t`Enter a limit above ${dollars(limitUSD)}, up to ${dollars(MAX_LIMIT)}.`;
  return Math.round(value * 100) / 100;
}

// When a plan's limit lifts, by the last of the windows that reached it, said as a sentence.
export function planResets(model: AgentSessionView["model"]): string | null {
  const when = resetWhen(
    model.subscription?.data.windows
      .filter((window) => window.usedPercent >= 100 || model.subscription?.data.limitReached)
      .map((window) => window.resetsAt)
      .filter((at): at is number => at !== undefined)
      .sort((a, b) => b - a)[0],
  );
  if (!when) return null;
  return when.day
    ? t`Your plan's limit resets ${when.day}, ${when.time}.`
    : t`Your plan's limit resets ${when.time}.`;
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
  computer,
  onDontContinue,
  onResumeSelected,
  resumeBlocked,
  onReport,
}: {
  agent: AgentSessionView;
  controls: TaskControls;
  onSettings(trigger: HTMLButtonElement, section?: "models" | "keys", tip?: SettingsTip): void;
  // Opens Keys at the form that stores this key's value again.
  onReenterKey?(trigger: HTMLButtonElement, id: string): void;
  // Sends a follow-up that carries on a task the user's action limit stopped.
  onContinue?(): Promise<boolean>;
  // Starts the conversation's next task to carry on one that was interrupted; left out while the
  // computer can't take a task.
  onCarryOn?(): Promise<boolean>;
  // Turns on the computer an interrupted task needs: it then carries on by itself.
  computer?: { label: string; reason?: string; run(): void };
  // "Don't continue" for an interrupted task still waiting on its plan's reset.
  onDontContinue?(): Promise<boolean>;
  onResumeSelected?(): Promise<boolean>;
  resumeBlocked?: string;
  // Opens Report a problem about this task.
  onReport?(trigger: HTMLElement, about: ReportAbout): void;
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
  const [carryOnWhenOn, setCarryOnWhenOn] = useState(false);
  const state = agent.model.state;
  const send = (run: () => Promise<boolean>) => {
    if (continuing) return;
    setContinuing(true);
    void run().then((sent) => {
      setContinuing(false);
      setProblem(sent ? null : t`That didn't go through. Try again.`);
    });
  };
  const carryOn = useRef(send);
  carryOn.current = send;
  useEffect(() => {
    if (!carryOnWhenOn || !onCarryOn) return;
    setCarryOnWhenOn(false);
    carryOn.current(onCarryOn);
  }, [carryOnWhenOn, onCarryOn]);
  // A restart ended a task waiting on its plan's reset: it still carries on by itself then.
  const wait = state?.state === "paused" ? planWait(state.reason, state.autoContinue) : undefined;
  const waiting = wait?.waiting ? wait : undefined;
  if (agent.interrupted && !controls.fenced)
    return (
      <section className="thread-recovery" aria-label={t`Task recovery`}>
        <h3 className="thread-recovery-title">
          {waiting ? waiting.title : t`I was cut off before I finished`}
        </h3>
        <p className="thread-recovery-text">
          {waiting
            ? waiting.text
            : t`localDot restarted while I was working. Continue, and I'll pick up where I left off.`}
        </p>
        <div className="thread-recovery-actions">
          {onCarryOn || !computer ? (
            <Button
              variant="primary"
              icon="continue"
              busy={continuing}
              disabledReason={onCarryOn ? undefined : t`Your computer is on its way`}
              onClick={() => onCarryOn && send(onCarryOn)}
            >
              {waiting ? t`Continue now` : t`Continue`}
            </Button>
          ) : (
            <Button
              variant="primary"
              icon="power"
              busy={carryOnWhenOn}
              disabledReason={computer.reason}
              onClick={() => {
                setCarryOnWhenOn(true);
                computer.run();
              }}
            >
              {t`${computer.label} and continue`}
            </Button>
          )}
          {waiting && onDontContinue && (
            <Button variant="quiet" busy={continuing} onClick={() => send(onDontContinue)}>
              {t`Don't continue`}
            </Button>
          )}
        </div>
        {problem && (
          <p className="thread-recovery-reason" role="alert">
            {problem}
          </p>
        )}
      </section>
    );
  const report = (trigger: HTMLElement, title: string, reason?: string) =>
    onReport?.(trigger, {
      context: {
        kind: "task",
        ...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
        ...(reason ? { reason } : {}),
      },
      title,
    });
  if (agent.model.ended?.reason === "error" && agent.sessionId && onReport && !controls.fenced) {
    const why = state?.state === "error" ? state.reason : undefined;
    return (
      <section className="thread-recovery" aria-label={t`Task recovery`}>
        <h3 className="thread-recovery-title">{t`The task ended with an error`}</h3>
        <p className="thread-recovery-text">
          {t`If it keeps happening, send a report so the localDot team can see what went wrong. You see everything in it before it goes.`}
        </p>
        <div className="thread-recovery-actions">
          <Button
            variant="secondary"
            onClick={(event) =>
              report(
                event.currentTarget,
                why ? t`The task ended: ${why}` : t`The task ended with an error.`,
                why,
              )
            }
          >
            {t`Report this problem`}
          </Button>
        </div>
      </section>
    );
  }
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
  const known = knownReason(reason, local, state.detail);
  const taskBudget =
    !subscription &&
    budget?.data.scope === "task" &&
    budget.data.taskId === agent.sessionId &&
    (hold ? hold === "task" : state.state === "paused");
  const dayLimit = hold ? hold === "day" : reason === "budget" && budget?.data.scope === "day";
  const raising = taskBudget && budget;
  const raised = raising ? raiseChoice(choice, custom, budget.data.limitUSD) : null;
  const resets = subscription ? planResets(agent.model) : null;
  const retry = RETRY.has(reason);
  const providerLimited =
    reason === STALL.providerLimit ||
    reason === "chatgpt plan limit reached" ||
    reason === "claude code plan limit reached";
  // The key to enter again, or to remove and add again, when keyd named one.
  const reentry = !hold && reason === STALL.keyReenter ? (state.detail ?? "") : undefined;
  const changed = !hold && reason === STALL.keyRebound ? (state.detail ?? "") : undefined;
  const fix = hold ? undefined : FIXES[reason ?? ""];
  const resume = limited ? (
    <Button
      variant="primary"
      busy={continuing}
      disabledReason={onContinue ? undefined : t`The task can't continue right now.`}
      onClick={() => onContinue && send(onContinue)}
    >
      {t`Continue`}
    </Button>
  ) : (
    <Button
      variant={raising || reentry !== undefined || fix ? "secondary" : "primary"}
      disabledReason={
        resumeBlocked ??
        (controls.canResumeTask ? undefined : t`The task can't continue right now.`)
      }
      busy={continuing}
      onClick={() => send(onResumeSelected ?? controls.resume)}
    >
      {raising ? t`Continue without raising` : retry ? t`Retry now` : t`Continue`}
    </Button>
  );
  return (
    <section className="thread-recovery" aria-label={t`Task recovery`}>
      <h3 className="thread-recovery-title">
        {reentry
          ? t`Re-enter your ${reentry} key`
          : changed
            ? t`Your ${changed} key was changed outside localDot`
            : (known?.title ??
              (hold || state.state === "paused" ? t`Task paused` : t`The task needs attention`))}
      </h3>
      <p className="thread-recovery-text">
        {dayLimit
          ? DAY_LIMIT
          : reason === "budget" && budget && !subscription
            ? spendingText(budget.data)
            : (known?.text ?? UNEXPLAINED)}
      </p>
      {reason && !known && (
        <p className="thread-recovery-reason">{t`Reported reason: ${reason}`}</p>
      )}
      {state.detail && !reentry && !changed && (
        <p className="thread-recovery-reason">
          {reason === STALL.modelRefused
            ? t`The provider said: ${state.detail}`
            : t`The model said: ${state.detail}`}
        </p>
      )}
      {resets && <p className="thread-recovery-reason">{resets}</p>}
      {!subscription && budget && reason === STALL.budget && (
        <div className="thread-recovery-meter">
          <p className="num">
            {budget.data.scope === "day"
              ? t`${dollars(budget.data.spentUSD)} of ${dollars(budget.data.limitUSD)} spent today`
              : t`${dollars(budget.data.spentUSD)} of ${dollars(budget.data.limitUSD)} spent`}
          </p>
          <Meter
            value={budget.data.spentUSD}
            max={budget.data.limitUSD}
            label={
              budget.data.scope === "day"
                ? t`Spent of today's limit`
                : t`Spent of this task's limit`
            }
          />
        </div>
      )}
      {raising ? (
        <form
          className="thread-recovery-raise"
          aria-label={t`Raise the spending limit`}
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
            aria-label={t`Raise the limit by`}
            items={[
              ...steps.map((raise) => ({ value: String(raise), label: `+$${raise}` })),
              { value: CUSTOM, label: t`Other` },
            ]}
            value={choice}
            onValueChange={(value) => {
              setChosen({ budget: budget.id, value });
              setProblem(null);
            }}
          />
          <Collapse open={choice === CUSTOM} className="thread-recovery-custom">
            <Field label={t`New limit`} error={problem}>
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
                controls.canRaiseBudget ? undefined : t`The limit can't be raised right now.`
              }
            >
              {typeof raised === "number"
                ? hold
                  ? t`Raise to ${dollars(raised)}`
                  : t`Raise to ${dollars(raised)} and continue`
                : hold
                  ? t`Raise the limit`
                  : t`Raise and continue`}
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
                {t`Re-enter key`}
              </Button>
            )}
            {fix && (
              <Button
                variant="primary"
                icon={fix.icon}
                onClick={(event) => onSettings(event.currentTarget, fix.section, fix.tip)}
              >
                {fix.label}
              </Button>
            )}
            {resume}
            {(retry || providerLimited) && reason !== STALL.modelBusy && (
              <Button
                variant="secondary"
                onClick={(event) => onSettings(event.currentTarget, "models")}
              >
                {t`Change model`}
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
        <p className="thread-recovery-reason">
          {t`The task stays paused until you press Continue.`}
        </p>
      )}
      <Disclosure summary={t`Recovery options`} className="thread-recovery-options">
        <div className="thread-recovery-actions">
          {raising && !hold && resume}
          <Button variant="quiet" onClick={(event) => onSettings(event.currentTarget)}>
            {t`Open Settings`}
          </Button>
          <Button variant="quiet" onClick={controls.recheck}>
            {t`Check task state`}
          </Button>
          {onReport && (
            <Button
              variant="quiet"
              onClick={(event) =>
                report(event.currentTarget, known?.title ?? t`The task needs attention`, reason)
              }
            >
              {t`Report this problem`}
            </Button>
          )}
        </div>
        <p className="thread-note">
          {onResumeSelected
            ? t`Continue starts the next task with your selected model and the conversation so far.`
            : t`Continuing keeps this task's model and its spending limit.`}
        </p>
      </Disclosure>
    </section>
  );
}
