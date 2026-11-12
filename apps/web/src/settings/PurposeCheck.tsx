import { JEV_HOST, JEV_MODEL, PurposeCheckStatus } from "@localdot/protocol";
import { useEffect, useState } from "react";
import { t } from "../i18n/index.ts";
import type { ApiClient } from "../lib/api.ts";
import { Button } from "../ui/Button.tsx";
import { Collapse } from "../ui/Disclosure.tsx";
import { Group, GroupRow } from "../ui/Group.tsx";
import { Switch } from "../ui/Switch.tsx";
import { roleActive } from "./choices.ts";
import { CLAUDE_CODE } from "./chooser.ts";
import type { SettingsDraft } from "./settings-form.ts";

// What Auto checks with: a saved Jev key, else the fast model, else nothing yet.
export type PurposeJudge = "jev" | "fast" | "none";

export interface PurposeCheckControl {
  on: boolean;
  api?: ApiClient;
  keyId?: string;
  fullAccess?: boolean;
  manageJevKey?(trigger: HTMLButtonElement): void;
  change(on: boolean): void;
  judge: PurposeJudge;
  // The plan the main model runs on, if any: a fast model checks only on Claude Code's own plan.
  plan?: string;
  // Opens Keys with a Jev key's form filled in.
  addJevKey?(trigger: HTMLButtonElement): void;
}

export function purposeJudge(jevKey: boolean, choices: SettingsDraft["choices"]): PurposeJudge {
  if (jevKey) return "jev";
  return roleActive("fast", choices) ? "fast" : "none";
}

export function purposeDescription({
  on,
  judge,
  plan,
  fullAccess,
}: Pick<PurposeCheckControl, "on" | "judge" | "plan" | "fullAccess">): string {
  if (!on) return t`Stops dot sending what it read somewhere unrelated.`;
  if (fullAccess)
    return t`Bypassed in Full access. Choose Auto or Custom permissions to use this check.`;
  if (judge === "jev")
    return t`Stops dot sending what it read somewhere unrelated. Uses Jev when a judgment is needed.`;
  if (judge === "fast")
    return t`Stops dot sending what it read somewhere unrelated. Checked by your fast model.`;
  if (plan === CLAUDE_CODE)
    return t`Stops dot sending what it read somewhere unrelated. Needs a Jev key or a fast model on Claude Code.`;
  if (plan)
    return t`Stops dot sending what it read somewhere unrelated. Needs a Jev key with the ChatGPT plan.`;
  return t`Stops dot sending what it read somewhere unrelated. Needs a Jev key or a fast model.`;
}

function lastOutcome(last: NonNullable<PurposeCheckStatus["last"]>): string {
  const at = new Date(last.at).toLocaleTimeString();
  if (last.ok) {
    const model = last.model ?? JEV_MODEL;
    return last.kind === "test"
      ? t`Test succeeded at ${at}. ${model} · ${last.latencyMs} ms`
      : t`Task check succeeded at ${at}. ${model} · ${last.latencyMs} ms`;
  }
  const problem = String(last.problem);
  return last.kind === "test"
    ? t`Test failed at ${at}. ${problem}`
    : t`Task check failed at ${at}. ${problem}`;
}

export function PurposeCheck({ control }: { control: PurposeCheckControl }) {
  const { on, judge, addJevKey, api, keyId, fullAccess, manageJevKey } = control;
  const [status, setStatus] = useState<PurposeCheckStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!api || !keyId) return;
    const abort = new AbortController();
    setStatus(undefined);
    setError(undefined);
    const refresh = () =>
      api
        .get("/api/agent/purpose-check", { signal: abort.signal })
        .then((reply) => {
          if (!abort.signal.aborted) {
            setStatus(PurposeCheckStatus.parse(reply));
            setError(undefined);
          }
        })
        .catch(() => {
          if (!abort.signal.aborted)
            setError(t`Could not load Jev status. Try again after updating localDot.`);
        });
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, 10_000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [api, keyId]);
  const test = async () => {
    if (!api || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      setStatus(PurposeCheckStatus.parse(await api.post("/api/agent/purpose-check/test")));
    } catch {
      setError(t`Could not test Jev. Check the connection to localDot and try again.`);
    } finally {
      setBusy(false);
    }
  };
  const last = status && status.keyId === keyId ? status.last : undefined;
  const outcome =
    error ??
    (status?.mode === "unavailable"
      ? t`The key layer is offline.`
      : last
        ? lastOutcome(last)
        : t`No Jev result recorded since localDot started. A saved key has not necessarily been tested.`);
  return (
    <Group>
      <Switch
        className="ui-group-row"
        label={t`Purpose check`}
        description={purposeDescription(control)}
        checked={on}
        onCheckedChange={control.change}
      />
      {judge === "jev" && (
        <>
          <GroupRow
            label="Jev"
            detail={`${JEV_MODEL} · ${JEV_HOST}`}
            trailing={!on ? t`Off` : fullAccess ? t`Bypassed` : t`Selected`}
          />
          <GroupRow label={t`API key`} detail={keyId ?? t`Saved in Keys`} onSelect={manageJevKey} />
          <GroupRow
            label={t`Connection`}
            detail={<span role="status">{outcome}</span>}
            trailing={
              api && (
                <Button
                  size="sm"
                  disabledReason={busy ? t`Testing Jev…` : undefined}
                  onClick={() => void test()}
                >
                  {busy ? t`Testing…` : t`Test Jev`}
                </Button>
              )
            }
          />
          <GroupRow
            label={t`When Jev runs`}
            detail={t`Checks uncertain destinations after private data is read, and routine approvals in Auto mode. Local rules and cached decisions need no API call. Full access bypasses both.`}
          />
          <GroupRow
            label={t`Requests since restart`}
            detail={
              status
                ? t`${status.calls} attempted · ${status.succeeded} succeeded · ${status.failed} failed`
                : t`Loading…`
            }
          />
          <GroupRow
            label={t`Connection test`}
            detail={t`Sends a short public-documentation example using this key. No conversation or computer content is sent. Provider usage charges may apply.`}
          />
        </>
      )}
      {addJevKey && (
        <Collapse open={on && judge !== "jev"}>
          <GroupRow
            label={t`Add a Jev key`}
            detail={
              judge === "fast"
                ? t`Jev, from typesafe.ai, checks faster than your fast model. Its key goes in Keys.`
                : t`Jev, from typesafe.ai, does the checking. Its key goes in Keys.`
            }
            onSelect={addJevKey}
          />
        </Collapse>
      )}
    </Group>
  );
}
