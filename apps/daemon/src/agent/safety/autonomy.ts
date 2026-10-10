import {
  type ActionClass,
  AlwaysOption,
  type AutonomyMode,
  AutonomyPolicy,
  type ScreenName,
} from "@localdot/protocol";
import type { ToolCallContext } from "../tools/deps.ts";
import { classify, commandLines } from "./classify.ts";
import type { RiskDecision, RiskFacts } from "./risk.ts";
import { ALWAYS_SCOPES, type Place } from "./rules.ts";

const MODE_RANK = { act: 0, ask: 1, handoff: 2 } as const;
const DESKTOP_ONLY = new Set<RiskFacts["operation"]>(["shell", "files_write", "files_delete"]);
const RISK_RANK = { none: 0, medium: 1, high: 2 } as const;

function mode(actionClass: ActionClass, policy: AutonomyPolicy): AutonomyMode {
  if (actionClass === "credentials") return "handoff";
  if (actionClass === "unknown" || actionClass === "network") return "ask";
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

// A command's destination depends on the shell, its config files and the hosts file, all of which
// the agent can change, so a command never names a site. The browser screen names no app: its
// "Chromium" is also the desktop browser's name.
export function placeOf(facts: RiskFacts): Place {
  if (facts.operation === "connector") return { tool: facts.connector?.exposed ?? "" };
  const target = facts.target;
  const site = facts.operation === "shell" ? undefined : siteOf(target?.url ?? facts.destination);
  return {
    ...(site ? { site } : {}),
    ...(target?.source === "ax" && target.app && facts.screen !== "browser"
      ? { app: target.app }
      : {}),
  };
}

export function alwaysOptions(
  actionClass: ActionClass,
  facts: RiskFacts,
  redact: (text: string) => string,
): AlwaysOption[] {
  // A yes for an app's tool lasts this task and covers that tool only.
  if (facts.operation === "connector")
    return ALWAYS_SCOPES[actionClass].includes("task") && facts.connector
      ? [{ scope: "task", label: "For this task", tool: facts.connector.exposed }]
      : [];
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
export function actingFacts(ctx: ToolCallContext, facts: RiskFacts): RiskFacts {
  const screen = DESKTOP_ONLY.has(facts.operation) ? "desktop" : screenOf(ctx);
  return { ...facts, screen, signedIn: ctx.session.taskAutonomy.signedIn(screen) };
}

export function decideAutonomy(ctx: ToolCallContext, facts: RiskFacts): RiskDecision {
  const acting = actingFacts(ctx, facts);
  const permission = ctx.session.permissionMode();
  if (permission !== "custom") {
    const classes = classify(acting);
    if (classes.includes("credentials"))
      return { actionClass: "credentials", mode: "handoff", risk: "high" };
    if (classes.includes("delete") || destructive(acting))
      return { actionClass: "delete", mode: "ask", risk: "high" };
    const actionClass =
      classes.find((c) => !["reading", "browsing", "computer"].includes(c)) ??
      classes[0] ??
      "unknown";
    return {
      actionClass,
      mode: permission === "full" || classes.every((c) => c === "reading") ? "act" : "ask",
      risk: risk(actionClass),
    };
  }
  const place = placeOf(acting);
  return decide(acting, ctx.session.autonomy, (actionClass) =>
    ctx.session.taskAutonomy.relaxes(actionClass, place),
  );
}

// The default policy distinguishes local files from online deletion. Full access
// still confirms destructive operations in the isolated computer as well.
function destructive(facts: RiskFacts): boolean {
  if (facts.operation === "files_delete") return true;
  if (facts.operation !== "shell" || !facts.command) return false;
  return commandLines(facts.command).some(({ text, runs }) => {
    if (/\.(?:rmtree|unlink|remove|rmdir)\s*\(/.test(text)) return true;
    return runs.some((words) => {
      const command = [words[0]?.replace(/^.*\//, ""), ...words.slice(1)].join(" ");
      return (
        /\b(?:rm|rmdir|unlink|shred|mkfs(?:\.[a-z0-9]+)?|wipefs|diskutil erase\w*|dd)\b/i.test(
          command,
        ) ||
        /\bgit\s+(?:clean|reset\s+--hard)\b|\b(?:drop\s+(?:table|database)|truncate\s+table)\b/i.test(
          command,
        )
      );
    });
  });
}
