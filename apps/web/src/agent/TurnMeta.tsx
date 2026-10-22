import { useRef, useState } from "react";
import "../ui/conversation-layout.css";
import { spendText, tokenCount } from "../copy/format.ts";
import { providerName, SPEED_NAMES } from "../settings/choices.ts";
import { subscription } from "../settings/chooser.ts";
import type { ModelNames } from "../settings/model-names.ts";
import { Button } from "../ui/Button.tsx";
import { Popover, triggerProps } from "../ui/Popover.tsx";
import { SpeedMark } from "../ui/SpeedMark.tsx";
import { clock } from "./activity.ts";
import type { ThreadItem, TurnModel } from "./thread.ts";

type MetaItem = Extract<ThreadItem, { kind: "meta" }>;

const ROLES: Record<string, string> = { fast: "Fast", local: "Local" };
const whole = (value: number) => value.toLocaleString();

// The line names the model, the speed above Standard it ran at, and its plan's app when the plan,
// not a key, paid for the turn. The work line above a turn says how long it took; cost belongs
// with model usage here.
function metaParts(item: MetaItem, names?: ModelNames) {
  const lead: Partial<TurnModel> | undefined = item.models[0] ?? item.main;
  if (!lead?.route || !lead.model) return undefined;
  const tokens = item.models.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
  return {
    name: names?.name(lead.route, lead.model) ?? lead.model,
    speed: lead.speed,
    rest: [
      subscription(lead.route) ? providerName(lead.route) : "",
      !item.work && (item.durationMs ?? 0) >= 1000 ? clock(item.durationMs ?? 0) : "",
      tokens ? tokenCount(tokens) : "",
      item.usd !== undefined ? spendText(item.usd, !!item.estimated) : "",
    ].filter(Boolean),
  };
}
export function metaLine(item: MetaItem, names?: ModelNames): string {
  const parts = metaParts(item, names);
  if (!parts) return "";
  return [parts.name, parts.speed && SPEED_NAMES[parts.speed], ...parts.rest]
    .filter(Boolean)
    .join(" · ");
}
// The line as shown: the speed is a mark beside the model's name, and in words for the label.
function MetaText({ item, names }: { item: MetaItem; names?: ModelNames }) {
  const parts = metaParts(item, names);
  if (!parts) return null;
  return (
    <span className="thread-meta-text num">
      {parts.name}
      {parts.speed && (
        <>
          {" "}
          <SpeedMark speed={parts.speed} />
        </>
      )}
      {parts.rest.map((part) => ` · ${part}`).join("")}
    </span>
  );
}

function Details({ item, names }: { item: MetaItem; names?: ModelNames }) {
  return (
    <dl className="thread-meta-models">
      {item.usd !== undefined && (
        <div>
          <dt>{item.estimated ? "Estimated cost" : "Cost"}</dt>
          <dd className="num">{spendText(item.usd, !!item.estimated)}</dd>
        </div>
      )}
      {item.models.map((row) => {
        const provider = names?.provider(row.route, row.model);
        return (
          <div key={`${row.role}:${row.route}:${row.model}`}>
            <dt>
              {names?.name(row.route, row.model) ?? row.model}
              {row.speed && (
                <>
                  {" "}
                  <SpeedMark speed={row.speed} />
                </>
              )}
              {ROLES[row.role] && <span className="thread-meta-role">{ROLES[row.role]}</span>}
            </dt>
            <dd className="num">
              {[
                provider && providerName(provider),
                row.speed && SPEED_NAMES[row.speed],
                `${whole(row.inputTokens)} in`,
                `${whole(row.outputTokens)} out`,
                row.reasoningTokens === undefined ? "" : `${whole(row.reasoningTokens)} reasoning`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

// A finished turn's last line: quiet, and opening on the tokens each model reported.
export function TurnMeta({ item, names }: { item: MetaItem; names?: ModelNames }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const line = metaLine(item, names);
  if (!line) return null;
  if (!item.models.length)
    return (
      <p className="thread-meta" data-under={item.work ? "work" : undefined}>
        <MetaText item={item} names={names} />
      </p>
    );
  return (
    <div className="thread-meta" data-under={item.work ? "work" : undefined}>
      <Button
        ref={trigger}
        variant="quiet"
        size="sm"
        className="thread-meta-trigger"
        aria-label={`This turn: ${line}`}
        {...triggerProps("dialog", open)}
        onClick={() => setOpen((shown) => !shown)}
      >
        <MetaText item={item} names={names} />
      </Button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={trigger}
        side="top"
        label="Models this turn used"
        className="thread-meta-popover"
      >
        <Details item={item} names={names} />
      </Popover>
    </div>
  );
}
