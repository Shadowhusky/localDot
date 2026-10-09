import { useRef, useState } from "react";
import { spendText, tokenCount } from "../copy/format.ts";
import { providerName } from "../settings/choices.ts";
import { subscription } from "../settings/chooser.ts";
import type { ModelNames } from "../settings/model-names.ts";
import { Button } from "../ui/Button.tsx";
import { Popover, triggerProps } from "../ui/Popover.tsx";
import { clock } from "./activity.ts";
import type { ThreadItem } from "./thread.ts";

type MetaItem = Extract<ThreadItem, { kind: "meta" }>;

const ROLES: Record<string, string> = { fast: "Fast", local: "Local" };
const whole = (value: number) => value.toLocaleString();

// The line names the model, and its plan's app when the plan, not a key, paid for the turn. The
// work line above a turn that worked already says how long it took and what it cost.
export function metaLine(item: MetaItem, names?: ModelNames): string {
  const lead = item.models[0] ?? item.main;
  if (!lead) return "";
  const tokens = item.models.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
  return [
    names?.name(lead.route, lead.model) ?? lead.model,
    subscription(lead.route) ? providerName(lead.route) : "",
    !item.work && (item.durationMs ?? 0) >= 1000 ? clock(item.durationMs ?? 0) : "",
    tokens ? tokenCount(tokens) : "",
    !item.work && item.usd !== undefined ? spendText(item.usd, false) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function Details({ item, names }: { item: MetaItem; names?: ModelNames }) {
  return (
    <dl className="thread-meta-models">
      {item.models.map((row) => {
        const provider = names?.provider(row.route, row.model);
        return (
          <div key={`${row.role}:${row.route}:${row.model}`}>
            <dt>
              {names?.name(row.route, row.model) ?? row.model}
              {ROLES[row.role] && <span className="thread-meta-role">{ROLES[row.role]}</span>}
            </dt>
            <dd className="num">
              {[
                provider && providerName(provider),
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
        <span className="thread-meta-text num">{line}</span>
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
        <span className="thread-meta-text num">{line}</span>
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
