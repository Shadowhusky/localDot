import type { PlanProvider, PlanUsageReply } from "@localdot/protocol";
import { useEffect, useId, useState } from "react";
import { Badge } from "../ui/Badge.tsx";
import { Meter } from "../ui/Meter.tsx";
import { VisuallyHidden } from "../ui/VisuallyHidden.tsx";
import {
  agoText,
  exactTime,
  type PlanTone,
  type PlanView,
  planView,
  shownPercent,
  untilText,
  type WindowView,
} from "./plan-usage.ts";
import { PLAN_NAMES } from "./UsageFooter.tsx";

const TONE_WORDS: Record<Exclude<PlanTone, "normal">, string> = {
  near: "Almost at limit",
  limit: "Limit reached",
};

// The time, kept current while something shows how far off a reset is.
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  return now;
}

// How the main model's plan stands, for the chip: only when a limit is near or reached.
export function planAlert(
  reply: PlanUsageReply | null | undefined,
  provider: string | undefined,
  now: number,
): { tone: Exclude<PlanTone, "normal">; words: string } | undefined {
  const plan = reply?.plans.find((row) => row.provider === provider);
  const tone = plan ? planView(plan, now).tone : "normal";
  if (!plan || tone === "normal") return undefined;
  return { tone, words: `${PLAN_NAMES[plan.provider]} ${TONE_WORDS[tone].toLowerCase()}` };
}

function When({ at, now, lead }: { at: number; now: number; lead: string }) {
  const exact = exactTime(at, now);
  return (
    <time dateTime={new Date(at).toISOString()} title={exact}>
      {lead} {untilText(at, now)}
      <VisuallyHidden>, {exact}</VisuallyHidden>
    </time>
  );
}

function LimitRow({ row, now }: { row: WindowView; now: number }) {
  const used = shownPercent(row.usedPercent);
  return (
    <div
      className="plan-usage-window"
      data-tone={!row.reset && row.usedPercent >= 100 ? "limit" : undefined}
    >
      <Meter
        label={row.name}
        value={row.reset ? 0 : row.usedPercent}
        valueText={row.reset ? "Reset" : `${used}% used`}
      />
      {row.resetsAt !== undefined && (
        <p className="plan-usage-line">
          {row.reset ? (
            `Reset ${exactTime(row.resetsAt, now)}. New usage not known yet.`
          ) : (
            <When at={row.resetsAt} now={now} lead="Resets" />
          )}
        </p>
      )}
    </div>
  );
}

function PlanBlock({
  provider,
  view,
  checking,
  now,
}: {
  provider: PlanProvider;
  view: PlanView | undefined;
  checking: boolean;
  now: number;
}) {
  const id = useId();
  const plan = view?.plan && `${view.plan.charAt(0).toUpperCase()}${view.plan.slice(1)}`;
  return (
    <section className="plan-usage" aria-labelledby={id}>
      <div className="plan-usage-head">
        <h3 id={id} className="plan-usage-title">
          {PLAN_NAMES[provider]}
          {plan ? ` · ${plan}` : ""}
        </h3>
        {view && view.tone !== "normal" && (
          <Badge
            kind="dot"
            tone={view.tone === "limit" ? "danger" : "attention"}
            label={TONE_WORDS[view.tone]}
          />
        )}
        {view?.asOf !== undefined && (
          <span className="plan-usage-age">As of {agoText(view.asOf, now)}</span>
        )}
      </div>
      {view?.limit && (
        <p className="plan-usage-limit">
          {view.limit.liftsAt === undefined ? (
            "Limit reached"
          ) : (
            <When at={view.limit.liftsAt} now={now} lead="Limit reached · resets" />
          )}
        </p>
      )}
      {view?.windows.map((row) => (
        <LimitRow key={row.window} row={row} now={now} />
      ))}
      {!view?.windows.length && !view?.limit && (
        <p className="plan-usage-line">
          {checking ? "Checking usage…" : "Usage appears after the first reply."}
        </p>
      )}
    </section>
  );
}

// Each subscription plan's 5-hour and weekly limits, as the plan last reported them.
export function PlanUsageList({
  reply,
  providers,
}: {
  reply: PlanUsageReply;
  providers: readonly PlanProvider[];
}) {
  const now = useNow(30_000);
  return (
    <div className="plan-usage-list">
      {providers.map((provider) => {
        const plan = reply.plans.find((row) => row.provider === provider);
        return (
          <PlanBlock
            key={provider}
            provider={provider}
            view={plan && planView(plan, now)}
            checking={reply.checking.includes(provider)}
            now={now}
          />
        );
      })}
    </div>
  );
}
