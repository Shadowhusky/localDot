import type { TaskModelSelection } from "@localdot/protocol";
import { useRef, useState } from "react";
import { count } from "../copy/format.ts";
import { Icon } from "../ui/Icon.tsx";
import { Meter } from "../ui/Meter.tsx";
import { Popover } from "../ui/Popover.tsx";
import { pressHandlers } from "../ui/press.ts";
import type { AgentModel } from "./model.ts";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const whole = (value: number) => value.toLocaleString();
const ROLES: Record<string, string> = { main: "Main", fast: "Fast", vision: "Vision" };
const PROVIDERS: Record<string, string> = { openai: "OpenAI", chatgpt: "ChatGPT", xai: "xAI" };
const roleName = (role: string) => ROLES[role] ?? role;
const providerName = (id: string) =>
  PROVIDERS[id] ?? `${id.slice(0, 1).toUpperCase()}${id.slice(1)}`;

export type ModelName = (provider: string, model: string) => string | undefined;

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

export function usageSummary(
  model: AgentModel,
  selection?: TaskModelSelection,
  modelName?: ModelName,
): string {
  const role =
    selection?.kind === "chatgpt"
      ? { provider: "chatgpt", model: selection.model }
      : selection?.kind === "api"
        ? (selection.roles.find((row) => row.role === "main") ?? selection.roles[0])
        : model.usage[0] && { provider: model.usage[0].route, model: model.usage[0].model };
  const main = role && (modelName?.(role.provider, role.model) ?? role.model);
  const tokens = model.usage.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
  return [main, tokens ? `${compact.format(tokens)} tokens` : "No usage yet"]
    .filter(Boolean)
    .join(" · ");
}

export function UsageDetails({
  model,
  selection,
  modelName,
}: {
  model: AgentModel;
  selection?: TaskModelSelection;
  modelName?: ModelName;
}) {
  const named = (provider: string, id: string) => modelName?.(provider, id) ?? id;
  const subscription = model.subscription;
  const reported = new Set(model.usage.map((row) => row.role));
  const waiting =
    selection?.kind === "api" ? selection.roles.filter((role) => !reported.has(role.role)) : [];
  const retry = model.retry?.data;
  return (
    <section className="usage-details" aria-label="Task usage">
      <h3 className="usage-title">Usage</h3>
      <dl className="usage-roles">
        {model.usage.map((row) => (
          <div key={`${row.role}:${row.route}:${row.model}`} className="usage-role">
            <dt>{roleName(row.role)}</dt>
            <dd>
              <span className="usage-model">{named(row.route, row.model)}</span>
              <span className="usage-line num">
                {whole(row.inputTokens)} in · {whole(row.outputTokens)} out
                {row.reasoningTokens === undefined
                  ? ""
                  : ` · ${whole(row.reasoningTokens)} reasoning${row.reasoningPartial ? " (some calls didn't say)" : ""}`}
              </span>
              <span className="usage-line">
                {providerName(row.route)} · {count(row.calls, "call", "calls")}
              </span>
            </dd>
          </div>
        ))}
        {waiting.map((role) => (
          <div key={role.role} className="usage-role">
            <dt>{roleName(role.role)}</dt>
            <dd>
              <span className="usage-model">{named(role.provider, role.model)}</span>
              <span className="usage-line">{providerName(role.provider)} · No calls yet</span>
            </dd>
          </div>
        ))}
        {selection?.kind === "chatgpt" && !model.usage.length && (
          <div className="usage-role">
            <dt>Main</dt>
            <dd>
              <span className="usage-model">{named("chatgpt", selection.model)}</span>
              <span className="usage-line">ChatGPT plan · No calls yet</span>
            </dd>
          </div>
        )}
      </dl>
      {!model.usage.length && !waiting.length && selection?.kind !== "chatgpt" && (
        <p className="usage-note">No model calls reported yet.</p>
      )}
      {(selection?.kind === "chatgpt" || subscription) && (
        <div className="usage-plan">
          <h4>ChatGPT plan{subscription?.data.plan ? ` · ${subscription.data.plan}` : ""}</h4>
          {(["primary", "secondary"] as const).map((name) => {
            const window = subscription?.data.windows.find((row) => row.window === name);
            if (!window) return null;
            const resets = resetTime(window.resetsAt);
            return (
              <div key={name} className="usage-window">
                <span className="usage-window-name">{windowName(window.windowMinutes)}</span>
                <Meter
                  value={window.usedPercent}
                  label={`${windowName(window.windowMinutes)} used`}
                />
                <span className="usage-line num">
                  {window.usedPercent}% used
                  {window.usedPercent >= 90 ? " · Almost at limit" : ""}
                  {resets ? ` · ${resets}` : ""}
                </span>
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
}: {
  model: AgentModel;
  selection?: TaskModelSelection;
  modelName?: ModelName;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const summary = usageSummary(model, selection, modelName);
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
        <span className="activity-usage-text num">{summary}</span>
        <Icon name="chevron-up" size={12} className="activity-usage-chevron" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={trigger} label="Usage" side="top">
        <UsageDetails model={model} selection={selection} modelName={modelName} />
      </Popover>
    </div>
  );
}
