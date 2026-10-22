import type { TaskModelSelection } from "@localdot/protocol";
import { useRef, useState } from "react";
import { count, dollars, spendText } from "../copy/format.ts";
import { providerName, SPEED_NAMES } from "../settings/choices.ts";
import { Button } from "../ui/Button.tsx";
import { Meter } from "../ui/Meter.tsx";
import { Popover } from "../ui/Popover.tsx";
import { pressHandlers } from "../ui/press.ts";
import { SpeedMark } from "../ui/SpeedMark.tsx";
import type { AgentModel, UsageRow } from "./model.ts";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const whole = (value: number) => value.toLocaleString();
const ROLES: Record<string, string> = {
  main: "Main",
  fast: "Fast",
  vision: "Vision",
  subagent: "Subagents",
};
const roleName = (role: string) => ROLES[role] ?? role;

export type ModelName = (provider: string, model: string) => string | undefined;

// The calls a speed above Standard served, as the provider said: all of them, or how many.
function speedText(row: UsageRow): string {
  if (!row.speed || !row.premiumCalls) return "";
  const name = SPEED_NAMES[row.speed];
  return row.premiumCalls === row.calls ? ` · ${name}` : ` · ${whole(row.premiumCalls)} ${name}`;
}

export function resetTime(seconds?: number, now = Date.now()): string | null {
  if (seconds === undefined) return null;
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = new Date(now).toDateString() === date.toDateString();
  return sameDay
    ? `Resets ${time}`
    : `Resets ${date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}, ${time}`;
}

function windowName(minutes?: number): string {
  if (minutes === undefined) return "Plan window";
  if (minutes % 1440 === 0) return `${count(minutes / 1440, "day", "days")} window`;
  if (minutes % 60 === 0) return `${count(minutes / 60, "hour", "hours")} window`;
  return `${count(minutes, "minute", "minutes")} window`;
}

// A plan's own app does the work: its usage is the plan's, not money.
const planApp = (selection?: TaskModelSelection) =>
  selection?.kind === "chatgpt" || selection?.kind === "claude-code" ? selection : undefined;
const PLAN_NAMES = { chatgpt: "ChatGPT plan", "claude-code": "Claude plan" } as const;

// Money is shown only where a task is billed per call: never for a plan.
export const billedPerCall = (selection?: TaskModelSelection) =>
  !planApp(selection) && !(selection?.kind === "api" && selection.plan);

// What one model has cost this task, from the calls the feed has seen.
function modelSpend(model: AgentModel, route: string, id: string) {
  const calls = model.spendCalls.filter((call) => call.route === route && call.model === id);
  if (!calls.length) return null;
  return {
    usd: calls.reduce((sum, call) => sum + call.usd, 0),
    estimated: calls.some((call) => call.estimated),
  };
}

// The usage line: the main model, then its figures, which never give way to a long name.
export function usageParts(
  model: AgentModel,
  selection?: TaskModelSelection,
  modelName?: ModelName,
): { main: string | undefined; figures: string } {
  const app = planApp(selection);
  const role = app
    ? { provider: app.kind, model: app.model }
    : selection?.kind === "api"
      ? (selection.roles.find((row) => row.role === "main") ?? selection.roles[0])
      : model.usage[0] && { provider: model.usage[0].route, model: model.usage[0].model };
  const main = role && (modelName?.(role.provider, role.model) ?? role.model);
  const tokens = model.usage.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
  const spent =
    model.spend && billedPerCall(selection)
      ? spendText(model.spend.taskUSD, model.spend.estimated)
      : null;
  return {
    main: main || undefined,
    figures: [tokens ? `${compact.format(tokens)} tokens` : "No usage yet", spent]
      .filter(Boolean)
      .join(" · "),
  };
}

export function usageSummary(
  model: AgentModel,
  selection?: TaskModelSelection,
  modelName?: ModelName,
): string {
  const { main, figures } = usageParts(model, selection, modelName);
  return main ? `${main} · ${figures}` : figures;
}

function limitText(spend: NonNullable<AgentModel["spend"]>): string {
  const limits = [
    spend.taskLimitUSD === undefined ? null : `${dollars(spend.taskLimitUSD)} per task`,
    spend.dayLimitUSD === undefined ? null : `${dollars(spend.dayLimitUSD)} a day`,
  ].filter(Boolean);
  return limits.length ? `Limit ${limits.join(" · ")}` : "No spending limit";
}

function Spending({
  model,
  onSpending,
}: {
  model: AgentModel;
  onSpending?(trigger: HTMLElement): void;
}) {
  const spend = model.spend;
  if (!spend) return null;
  // Today includes other tasks, whose calls this feed never saw: plain only when it is all ours.
  const todayEstimated = spend.estimated || spend.dayUSD > spend.taskUSD + 1e-9;
  return (
    <>
      <dl className="usage-spend">
        <div>
          <dt>This task</dt>
          <dd className="num">{spendText(spend.taskUSD, spend.estimated)}</dd>
        </div>
        <div>
          <dt>
            Today<span className="usage-line">All tasks</span>
          </dt>
          <dd className="num">{spendText(spend.dayUSD, todayEstimated)}</dd>
        </div>
      </dl>
      {(spend.estimated || todayEstimated) && (
        <p className="usage-note">≈ is an estimate from token counts and list prices.</p>
      )}
      <div className="usage-limit">
        <span className="usage-line">{limitText(spend)}</span>
        {onSpending && (
          <Button variant="quiet" size="sm" onClick={(event) => onSpending(event.currentTarget)}>
            {spend.taskLimitUSD === undefined && spend.dayLimitUSD === undefined
              ? "Set a limit…"
              : "Change…"}
          </Button>
        )}
      </div>
    </>
  );
}

export function UsageDetails({
  model,
  selection,
  modelName,
  onSpending,
}: {
  model: AgentModel;
  selection?: TaskModelSelection;
  modelName?: ModelName;
  onSpending?(trigger: HTMLElement): void;
}) {
  const named = (provider: string, id: string) => modelName?.(provider, id) ?? id;
  const subscription = model.subscription;
  const reported = new Set(model.usage.map((row) => row.role));
  const waiting =
    selection?.kind === "api" ? selection.roles.filter((role) => !reported.has(role.role)) : [];
  const retry = model.retry?.data;
  const money = billedPerCall(selection);
  const app = planApp(selection);
  const plan = app?.kind ?? subscription?.data.provider;
  return (
    <section className="usage-details" aria-label="Task usage">
      <h3 className="usage-title">Usage</h3>
      {money && <Spending model={model} onSpending={onSpending} />}
      <dl className="usage-roles">
        {model.usage.map((row) => {
          const spent = money ? modelSpend(model, row.route, row.model) : null;
          return (
            <div key={`${row.role}:${row.route}:${row.model}`} className="usage-role">
              <dt>{roleName(row.role)}</dt>
              <dd>
                <span className="usage-model">
                  {named(row.route, row.model)}
                  {row.speed && (
                    <>
                      {" "}
                      <SpeedMark speed={row.speed} />
                    </>
                  )}
                </span>
                <span className="usage-line num">
                  {whole(row.inputTokens)} in · {whole(row.outputTokens)} out
                  {row.reasoningTokens === undefined
                    ? ""
                    : ` · ${whole(row.reasoningTokens)} reasoning${row.reasoningPartial ? " (some calls didn't say)" : ""}`}
                </span>
                <span className="usage-line num">
                  {providerName(row.route)} · {count(row.calls, "call", "calls")}
                  {speedText(row)}
                  {spent ? ` · ${spendText(spent.usd, spent.estimated)}` : ""}
                </span>
              </dd>
            </div>
          );
        })}
        {waiting.map((role) => (
          <div key={role.role} className="usage-role">
            <dt>{roleName(role.role)}</dt>
            <dd>
              <span className="usage-model">{named(role.provider, role.model)}</span>
              <span className="usage-line">{providerName(role.provider)} · No calls yet</span>
            </dd>
          </div>
        ))}
        {app && !model.usage.length && (
          <div className="usage-role">
            <dt>Main</dt>
            <dd>
              <span className="usage-model">{named(app.kind, app.model)}</span>
              <span className="usage-line">{PLAN_NAMES[app.kind]} · No calls yet</span>
            </dd>
          </div>
        )}
      </dl>
      {!model.usage.length && !waiting.length && !app && (
        <p className="usage-note">No model calls reported yet.</p>
      )}
      {selection?.kind === "api" && selection.plan && (
        <p className="usage-note">Included in your plan. Uses your plan's limits.</p>
      )}
      {plan && (
        <div className="usage-plan">
          <h4>
            {PLAN_NAMES[plan]}
            {subscription?.data.plan ? ` · ${subscription.data.plan}` : ""}
          </h4>
          {(["primary", "secondary"] as const).map((name) => {
            const window = subscription?.data.windows.find((row) => row.window === name);
            if (!window) return null;
            const resets = resetTime(window.resetsAt);
            return (
              <div key={name} className="usage-window">
                <Meter
                  label={windowName(window.windowMinutes)}
                  value={window.usedPercent}
                  valueText={`${window.usedPercent}% used`}
                />
                {resets && <span className="usage-line num">{resets}</span>}
              </div>
            );
          })}
          {!subscription?.data.windows.length && (
            <p className="usage-note">The plan hasn't reported its limits yet.</p>
          )}
          {subscription?.data.limitReached && (
            <p className="usage-note">
              The plan limit is reached. Wait for it to reset, then continue the task.
            </p>
          )}
        </div>
      )}
      {retry && (
        <p className="usage-note">
          {`${roleName(retry.role)} model retried (try ${retry.attempt}) after ${(retry.waitMs / 1000).toFixed(1)} s: `}
          {retry.message}
          {retry.fallback ? ` Switched to ${retry.fallback}.` : ""}
        </p>
      )}
      {model.usagePartial && <p className="usage-note">Only recent usage is shown.</p>}
    </section>
  );
}

export function UsageFooter({
  model,
  selection,
  modelName,
  onSpending,
}: {
  model: AgentModel;
  selection?: TaskModelSelection;
  modelName?: ModelName;
  onSpending?(trigger: HTMLElement): void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const { main, figures } = usageParts(model, selection, modelName);
  const summary = main ? `${main} · ${figures}` : figures;
  return (
    <div className="activity-usage">
      <button
        {...pressHandlers}
        ref={trigger}
        type="button"
        className="activity-usage-trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Usage: ${summary}`}
        onClick={() => setOpen((shown) => !shown)}
      >
        {main && <span className="activity-usage-text">{main}</span>}
        <span className="activity-usage-figures num">{figures}</span>
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={trigger}
        label="Usage"
        side="top"
        className="activity-usage-popover"
      >
        <UsageDetails
          model={model}
          selection={selection}
          modelName={modelName}
          onSpending={
            onSpending &&
            ((trigger) => {
              setOpen(false);
              onSpending(trigger);
            })
          }
        />
      </Popover>
    </div>
  );
}
