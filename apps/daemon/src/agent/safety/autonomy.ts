import {
  type ActionClass,
  AlwaysOption,
  type AutonomyMode,
  AutonomyPolicy,
  type ScreenName,
} from "@localdot/protocol";
import type { ToolCallContext } from "../tools/deps.ts";
import { classify } from "./classify.ts";
import type { RiskDecision, RiskFacts } from "./risk.ts";
import { ALWAYS_SCOPES, type Place } from "./rules.ts";

const MODE_RANK = { act: 0, ask: 1, handoff: 2 } as const;
const DESKTOP_ONLY = new Set<RiskFacts["operation"]>(["shell", "files_write", "files_delete"]);
const RISK_RANK = { none: 0, medium: 1, high: 2 } as const;
const PLAIN_URL = /^https?:\/\/[^\s"'`$\\{}()<>|;&*?[\]!^~]+$/i;

function mode(actionClass: ActionClass, policy: AutonomyPolicy): AutonomyMode {
  if (actionClass === "credentials") return "handoff";
  if (actionClass === "unknown") return "ask";
  if (actionClass === "upload") return policy.send === "handoff" ? "handoff" : "ask";
  return policy[actionClass];
}

function risk(actionClass: ActionClass): RiskDecision["risk"] {
  if (["reading", "browsing", "computer"].includes(actionClass)) return "none";
  return actionClass === "unknown" || actionClass === "memory" ? "medium" : "high";
}

// A task allowance or saved rule only turns ask into act, class by class.
export function decide(
  facts: RiskFacts,
  rawPolicy: AutonomyPolicy,
  relaxed: (actionClass: ActionClass) => boolean = () => false,
): RiskDecision {
  const policy = AutonomyPolicy.parse(rawPolicy);
  return classify(facts)
    .map((actionClass) => {
      const asked = mode(actionClass, policy);
      return {
        actionClass,
        mode: asked === "ask" && relaxed(actionClass) ? "act" : asked,
        risk: risk(actionClass),
      };
    })
    .reduce((best, next) =>
      MODE_RANK[next.mode] > MODE_RANK[best.mode] ||
      (next.mode === best.mode && RISK_RANK[next.risk] > RISK_RANK[best.risk])
        ? next
        : best,
    );
}

function siteOf(value: string | undefined): string | undefined {
  if (!value || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
    ? url.origin
    : undefined;
}

// A URL names a command's site only when the shell cannot rewrite it: a plain or wholly quoted
// word with no expansion or escape. Any other URL-like word leaves the command without a site.
function commandSites(command: string): string[] {
  const sites = new Set<string>();
  for (const word of command.split(/\s+/)) {
    if (!word.includes("://")) continue;
    const bare = /^(["'])(.*)\1$/.exec(word)?.[2] ?? word;
    const site = PLAIN_URL.test(bare) ? siteOf(bare) : undefined;
    if (!site) return [];
    sites.add(site);
  }
  return [...sites];
}

export function placeOf(facts: RiskFacts): Place {
  const target = facts.target;
  const sites =
    facts.operation === "shell"
      ? commandSites(facts.command ?? "")
      : [siteOf(target?.url ?? facts.destination)].filter((site) => site !== undefined);
  return {
    ...(sites.length === 1 ? { site: sites[0] } : {}),
    ...(target?.source === "ax" && target.app ? { app: target.app } : {}),
  };
}

export function alwaysOptions(
  actionClass: ActionClass,
  facts: RiskFacts,
  redact: (text: string) => string,
): AlwaysOption[] {
  const { site, app } = placeOf(facts);
  const shown = (value: string | undefined): value is string =>
    value !== undefined && redact(value) === value;
  return ALWAYS_SCOPES[actionClass]
    .flatMap((scope): AlwaysOption[] => {
      if (scope === "task") return [{ scope, label: "For this task" }];
      if (scope === "always") return [{ scope, label: "Always" }];
      if (scope === "app") return shown(app) ? [{ scope, label: `In ${app}`, app }] : [];
      if (!shown(site)) return [];
      const url = new URL(site);
      return [{ scope, label: `On ${url.protocol === "https:" ? url.host : site}`, site }];
    })
    .filter((option) => AlwaysOption.safeParse(option).success);
}

export function screenOf(ctx: ToolCallContext): ScreenName {
  return ctx.screen?.selection.screen ?? ctx.session.screens?.selection.screen ?? "desktop";
}

// Commands and file changes run on the desktop whichever screen is selected.
export function decideAutonomy(ctx: ToolCallContext, facts: RiskFacts): RiskDecision {
  const screen = DESKTOP_ONLY.has(facts.operation) ? "desktop" : screenOf(ctx);
  const place = placeOf(facts);
  return decide(
    { ...facts, screen, signedIn: ctx.session.taskAutonomy.signedIn(screen) },
    ctx.session.autonomy,
    (actionClass) => ctx.session.taskAutonomy.relaxes(actionClass, place),
  );
}
