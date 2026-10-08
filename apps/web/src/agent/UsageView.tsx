import type { TaskModelSelection } from "@localdot/protocol";
import { count } from "../copy/format.ts";
import type { AgentModel } from "./model.ts";
import "./usage.css";

const number = (value: number) => value.toLocaleString();
export function resetTime(seconds?: number): string {
  if (seconds === undefined) return "Reset time unavailable";
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime())
    ? `Resets ${date.toLocaleString()}`
    : "Reset time unavailable";
}
export function UsageView({
  model,
  selection,
}: {
  model: AgentModel;
  selection?: TaskModelSelection;
}) {
  const subscription = model.subscription;
  return (
    <section className="usage-view" aria-label="Task usage">
      <h3>Usage</h3>
      {selection?.kind === "chatgpt" ? (
        <p>Main · ChatGPT · {selection.model}</p>
      ) : selection?.kind === "api" ? (
        <ul>
          {selection.roles.map((role) => (
            <li key={role.role}>
              {role.role} · {role.provider} · {role.model}
            </li>
          ))}
        </ul>
      ) : (
        <p>Frozen model identity has not been reported.</p>
      )}
      {model.usage.length ? (
        <ul className="usage-tokens">
          {model.usage.map((row) => (
            <li key={`${row.role}:${row.route}:${row.model}`}>
              <strong>
                {row.role} · {row.model}
              </strong>
              <span>Route: {row.route}</span>
              <span>
                {number(row.inputTokens)} input ·{" "}
                {count(row.outputTokens, "output token", "output tokens")}
              </span>
              <span>
                {row.reasoningTokens === undefined
                  ? "Reasoning tokens unavailable"
                  : `${count(row.reasoningTokens, "reported reasoning token", "reported reasoning tokens")}${row.reasoningPartial ? " · some calls did not report reasoning" : ""}`}{" "}
                · {count(row.calls, "reported call", "reported calls")}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p>No model token usage reported yet.</p>
      )}
      <p className="history-note">
        {model.usagePartial ? "Only retained token usage is shown. " : ""}Token counts do not
        establish an invoice cost.
      </p>
      {(selection?.kind === "chatgpt" || subscription) && (
        <div className="plan-usage">
          <h4>ChatGPT plan{subscription?.data.plan ? ` · ${subscription.data.plan}` : ""}</h4>
          <p>
            Model calls use the plan. Desktop key use has its own limits and can still be refused.
          </p>
          {(["primary", "secondary"] as const).map((name) => {
            const window = subscription?.data.windows.find((row) => row.window === name);
            return (
              <div key={name}>
                <strong>{name === "primary" ? "Primary" : "Secondary"} window</strong>
                {window ? (
                  <>
                    <p>
                      {window.usedPercent}% used
                      {window.windowMinutes === undefined
                        ? ""
                        : ` · ${number(window.windowMinutes)} minutes`}
                    </p>
                    <meter
                      aria-label={`${name} plan usage`}
                      value={window.usedPercent}
                      min={0}
                      max={100}
                    />
                    <p>{resetTime(window.resetsAt)}</p>
                  </>
                ) : (
                  <p>Usage unavailable · Reset time unavailable</p>
                )}
              </div>
            );
          })}
          {subscription?.data.limitReached && (
            <p>
              Plan limit reported. Wait for the reported reset or repair the account before
              explicitly resuming.
            </p>
          )}
          {subscription && (
            <p className="history-note">
              Last recorded plan report. This view does not refresh the account.
            </p>
          )}
        </div>
      )}
      {model.retry && (
        <div className="retry-note">
          <h4>Reported retry</h4>
          <p>
            {model.retry.data.role} · attempt {model.retry.data.attempt} ·{" "}
            {number(model.retry.data.waitMs)} ms wait
          </p>
          <p>{model.retry.data.message}</p>
          {model.retry.data.fallback && (
            <p>The backend reported fallback to {model.retry.data.fallback}.</p>
          )}
          <p className="history-note">Informational; the browser does not retry model calls.</p>
        </div>
      )}
    </section>
  );
}
