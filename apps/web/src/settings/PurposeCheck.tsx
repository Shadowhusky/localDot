import { JEV_HOST, JEV_MODEL, PurposeCheckStatus } from "@localdot/protocol";
import { useEffect, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { Button } from "../ui/Button.tsx";
import { Collapse } from "../ui/Disclosure.tsx";
import { Group, GroupRow } from "../ui/Group.tsx";
import { Switch } from "../ui/Switch.tsx";
import { CLAUDE_CODE, subscription } from "./chooser.ts";
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
  // The plan the main model runs on, if any. A plan runs no fast model of its own, so only a Jev
  // key can check.
  plan?: string;
  // Opens Keys with a Jev key's form filled in.
  addJevKey?(trigger: HTMLButtonElement): void;
}

export function purposeJudge(jevKey: boolean, choices: SettingsDraft["choices"]): PurposeJudge {
  if (jevKey) return "jev";
  return choices.fast && !subscription(choices.main?.provider) ? "fast" : "none";
}

const WHY = "Stops dot sending what it read somewhere unrelated.";

export function purposeDescription({
  on,
  judge,
  plan,
  fullAccess,
}: Pick<PurposeCheckControl, "on" | "judge" | "plan" | "fullAccess">): string {
  if (!on) return WHY;
  if (fullAccess)
    return "Bypassed in Full access. Choose Auto or Custom permissions to use this check.";
  if (judge === "jev") return `${WHY} Uses Jev when a judgment is needed.`;
  if (judge === "fast") return `${WHY} Checked by your fast model.`;
  const needs =
    plan === CLAUDE_CODE
      ? " with Claude Code"
      : plan
        ? " with the ChatGPT plan"
        : " or a fast model";
  return `${WHY} Needs a Jev key${needs}.`;
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
            setError("Could not load Jev status. Try again after updating localDot.");
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
      setError("Could not test Jev. Check the connection to localDot and try again.");
    } finally {
      setBusy(false);
    }
  };
  const last = status && status.keyId === keyId ? status.last : undefined;
  const outcome =
    error ??
    (status?.mode === "unavailable"
      ? "The key layer is offline."
      : last
        ? `${last.kind === "test" ? "Test" : "Task check"} ${last.ok ? "succeeded" : "failed"} at ${new Date(last.at).toLocaleTimeString()}. ${last.ok ? `${last.model ?? JEV_MODEL} · ${last.latencyMs} ms` : last.problem}`
        : "No Jev result recorded since localDot started. A saved key has not necessarily been tested.");
  return (
    <Group>
      <Switch
        className="ui-group-row"
        label="Purpose check"
        description={purposeDescription(control)}
        checked={on}
        onCheckedChange={control.change}
      />
      {judge === "jev" && (
        <>
          <GroupRow
            label="Jev"
            detail={`${JEV_MODEL} · ${JEV_HOST}`}
            trailing={!on ? "Off" : fullAccess ? "Bypassed" : "Selected"}
          />
          <GroupRow label="API key" detail={keyId ?? "Saved in Keys"} onSelect={manageJevKey} />
          <GroupRow
            label="Connection"
            detail={<span role="status">{outcome}</span>}
            trailing={
              api && (
                <Button
                  size="sm"
                  disabledReason={busy ? "Testing Jev…" : undefined}
                  onClick={() => void test()}
                >
                  {busy ? "Testing…" : "Test Jev"}
                </Button>
              )
            }
          />
          <GroupRow
            label="When Jev runs"
            detail="Checks uncertain destinations after private data is read, and routine approvals in Auto mode. Local rules and cached decisions need no API call. Full access bypasses both."
          />
          <GroupRow
            label="Requests since restart"
            detail={
              status
                ? `${status.calls} attempted · ${status.succeeded} succeeded · ${status.failed} failed`
                : "Loading…"
            }
          />
          <GroupRow
            label="Connection test"
            detail="Sends a short public-documentation example using this key. No conversation or computer content is sent. Provider usage charges may apply."
          />
        </>
      )}
      {addJevKey && (
        <Collapse open={on && judge !== "jev"}>
          <GroupRow
            label="Add a Jev key"
            detail={
              judge === "fast"
                ? "Jev, from typesafe.ai, checks faster than your fast model. Its key goes in Keys."
                : "Jev, from typesafe.ai, does the checking. Its key goes in Keys."
            }
            onSelect={addJevKey}
          />
        </Collapse>
      )}
    </Group>
  );
}
