import { BudgetRaiseRequest } from "@localdot/protocol";
import { useState } from "react";
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
function knownReason(
  reason: string | undefined,
  local: boolean,
): { title: string; text: string } | undefined {
  if (reason === "budget")
    return {
      title: "Paused at the spending limit",
      text: "dot reached this task's spending limit. Raise it to continue; what was spent stays counted.",
    };
  if (reason === "keyd unavailable")
    return {
      title: "Keys are offline",
      text: "dot can't reach your keys. Bring Keys back online, check the task, then continue.",
    };
  if (reason === "chatgpt sign-in expired" || reason === "chatgpt account changed")
    return {
      title: "Sign in to ChatGPT again",
      text: "Repair the ChatGPT account in Settings, then continue this task.",
    };
  if (reason === "chatgpt plan limit reached")
    return {
      title: "Paused at your plan's limit",
      text: "Your ChatGPT plan is at its limit. Continue once it resets; this task has no spending limit of its own.",
    };
  if (reason === "model unavailable")
    return {
      title: "The model isn't available",
      text: local
        ? "The local model is unavailable. Start its server and load the chosen model, then continue."
        : "The chosen model could not continue. Check its provider and access, then continue.",
    };
  return undefined;
}
// Whole dollars without cents; anything else to the cent.
export const dollars = (value: number) =>
  `$${value.toLocaleString(undefined, {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
// What a chip adds to the limit.
const RAISES = [2, 5, 10] as const;
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

export function TaskRecovery({
  agent,
  controls,
  onSettings,
}: {
  agent: AgentSessionView;
  controls: TaskControls;
  onSettings(trigger: HTMLButtonElement): void;
}) {
  const budget = agent.model.budget;
  const need = budget?.data.needUSD;
  const [choice, setChoice] = useState<string>(() =>
    String(RAISES.find((raise) => need === undefined || raise >= need) ?? RAISES.at(-1)),
  );
  const [custom, setCustom] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const state = agent.model.state;
  if (
    controls.fenced ||
    agent.snapshot?.pause ||
    !agent.sessionId ||
    agent.model.ended ||
    !state ||
    !["paused", "error"].includes(state.state) ||
    (state.state === "paused" && ownedPause(state.reason))
  )
    return null;
  const subscription = agent.snapshot?.models?.kind === "chatgpt" || !!agent.model.subscription;
  const local =
    agent.snapshot?.models?.kind === "api" &&
    agent.snapshot.models.roles.some(
      (role) => role.role === "main" && ["ollama", "lmstudio"].includes(role.provider),
    );
  const known = knownReason(state.reason, local);
  const taskBudget =
    !subscription && budget?.data.scope === "task" && budget.data.taskId === agent.sessionId;
  const raising = taskBudget && state.state === "paused" && budget;
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
  const resume = (
    <Button
      variant={raising ? "secondary" : "primary"}
      disabledReason={controls.canResumeTask ? undefined : "The task can't continue right now."}
      onClick={() => void controls.resume()}
    >
      {raising ? "Continue without raising" : "Continue"}
    </Button>
  );
  return (
    <section className="thread-recovery" aria-label="Task recovery">
      <h3 className="thread-recovery-title">
        {known?.title ?? (state.state === "paused" ? "Task paused" : "The task needs attention")}
      </h3>
      <p className="thread-recovery-text">{known?.text ?? UNEXPLAINED}</p>
      {state.reason && !known && (
        <p className="thread-recovery-reason">Reported reason: {state.reason}</p>
      )}
      {resets && (
        <p className="thread-recovery-reason">
          {resets.replace(/^Resets/, "Your plan's limit resets")}.
        </p>
      )}
      {!subscription && budget && (
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
      {budget?.data.scope === "day" && (
        <p className="thread-recovery-reason">
          This is the daily limit for all tasks. Change it in Settings, then continue.
        </p>
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
              ...RAISES.map((raise) => ({ value: String(raise), label: `+$${raise}` })),
              { value: CUSTOM, label: "Other" },
            ]}
            value={choice}
            onValueChange={(value) => {
              setChoice(value);
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
                ? `Raise to ${dollars(raised)} and continue`
                : "Raise and continue"}
            </Button>
          </div>
        </form>
      ) : (
        <div className="thread-recovery-actions">{resume}</div>
      )}
      <Disclosure summary="Recovery options" className="thread-recovery-options">
        <div className="thread-recovery-actions">
          {raising && resume}
          <Button variant="quiet" onClick={(event) => onSettings(event.currentTarget)}>
            Open Settings
          </Button>
          <Button variant="quiet" onClick={controls.recheck}>
            Check task state
          </Button>
        </div>
        <p className="thread-note">Continuing keeps this task's model and its spending limit.</p>
      </Disclosure>
    </section>
  );
}
