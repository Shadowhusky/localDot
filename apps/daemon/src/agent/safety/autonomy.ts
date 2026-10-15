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
// Of equally strict decisions, the one that names the step: the hardest to take back first.
const PRECEDENCE: readonly ActionClass[] = [
  "credentials",
  "purchase",
  "delete",
  "upload",
  "system_settings",
  "send",
  "post",
  "download_execute",
  "network",
  "unknown",
  "memory",
  "computer",
  "browsing",
  "reading",
];
// Auto asks the user before these whatever its judge would say, except a deletion inside the
// computer that is all the step asks about.
const UNJUDGED = new Set<ActionClass>(["credentials", "purchase", "delete"]);

export interface AutonomyDecision extends RiskDecision {
  // Where the step acts, for the class decided: a yes for this task covers steps there only.
  readonly place: Place;
  // An ask Auto's judge may answer in the user's place.
  readonly judge?: true;
}

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

function stricter<T extends RiskDecision>(best: T, next: T): T {
  if (next.mode !== best.mode) return MODE_RANK[next.mode] > MODE_RANK[best.mode] ? next : best;
  if (next.risk !== best.risk) return RISK_RANK[next.risk] > RISK_RANK[best.risk] ? next : best;
  return PRECEDENCE.indexOf(next.actionClass) < PRECEDENCE.indexOf(best.actionClass) ? next : best;
}

// A preset's decision for a class before any allowance. Full asks only before paying or deleting
// online data. Auto always asks before paying, deleting online data or a sweeping deletion, and
// leaves the rest but reading, browsing and work in the computer to its judge, or with none to the
// user's own settings.
function preset(
  actionClass: ActionClass,
  permission: "auto" | "full",
  inside: Place["inside"],
  unjudged: AutonomyPolicy | undefined,
): AutonomyMode {
  if (actionClass === "credentials") return "handoff";
  if (actionClass === "purchase" || (actionClass === "delete" && inside !== "local")) return "ask";
  if (permission === "full" || ["reading", "browsing", "computer"].includes(actionClass))
    return "act";
  return unjudged ? mode(actionClass, unjudged) : "ask";
}

// Auto's judge is Jev, which the task's purpose check also uses whenever a Jev key is saved: with
// no Jev there, nothing can approve in the user's place.
function judges(ctx: ToolCallContext): boolean {
  const gate = ctx.session.purpose;
  return ctx.session.autoPermit !== undefined && (gate === undefined || gate.judgeName === "jev");
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
    .reduce(stricter);
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

// Commands and file changes run on the desktop whichever screen is selected. A fetch made without
// the user's cookies is never signed in.
export function actingFacts(ctx: ToolCallContext, facts: RiskFacts): RiskFacts {
  const screen = DESKTOP_ONLY.has(facts.operation) ? "desktop" : screenOf(ctx);
  return {
    ...facts,
    screen,
    signedIn: facts.signedIn !== false && ctx.session.taskAutonomy.signedIn(screen),
  };
}

// `judging` says whether Auto may ask its judge; with none to ask, the user's own settings decide
// in its place.
export function decideAutonomy(
  ctx: ToolCallContext,
  facts: RiskFacts,
  judging = judges(ctx),
): AutonomyDecision {
  const acting = actingFacts(ctx, facts);
  const permission = ctx.session.permissionMode();
  const place = placeOf(acting);
  const relaxes = (actionClass: ActionClass, at: Place) =>
    ctx.session.taskAutonomy.relaxes(actionClass, at);
  // A connected app's tool the user set to ask first asks in every mode, never the judge, until
  // they say yes for this task.
  if (acting.connector?.asks) {
    const decision = decide(acting, ctx.session.autonomy, (actionClass) =>
      relaxes(actionClass, place),
    );
    if (decision.mode !== "handoff")
      return { ...decision, mode: relaxes(decision.actionClass, place) ? "act" : "ask", place };
  }
  if (permission === "custom")
    return {
      ...decide(acting, ctx.session.autonomy, (actionClass) => relaxes(actionClass, place)),
      place,
    };
  const classes = [...classify(acting)];
  // Presets change the default decision, not the scope of a user's explicit approval.
  // Keep each class independent: allowing deletion must not also allow a credential
  // action, upload, or unrelated destination carried by the same step.
  const inside =
    permission === "auto" && !classes.includes("delete") ? deletion(acting) : undefined;
  if (inside) classes.push("delete");
  const unjudged =
    permission === "auto" && !judging ? AutonomyPolicy.parse(ctx.session.autonomy) : undefined;
  const decisions = classes.map((actionClass): AutonomyDecision => {
    const at = actionClass === "delete" && inside ? { ...place, inside } : place;
    const asked = preset(actionClass, permission, inside, unjudged);
    return {
      actionClass,
      mode: asked === "ask" && relaxes(actionClass, at) ? "act" : asked,
      risk: risk(actionClass),
      place: at,
    };
  });
  const decision = decisions.reduce(stricter);
  // The judge's question about a local deletion answers for nothing else the step does.
  const local =
    inside === "local" &&
    decision.actionClass === "delete" &&
    decision.mode === "ask" &&
    decisions.every((other) => other === decision || other.mode === "act");
  const judge =
    permission === "auto" &&
    judging &&
    decision.mode === "ask" &&
    (local || !classes.some((actionClass) => UNJUDGED.has(actionClass)));
  return { ...decision, ...(local ? { local: true } : {}), ...(judge ? { judge: true } : {}) };
}

const TEMP_DIRECTORY = String.raw`\/(?:tmp|var\/tmp|private\/tmp)`;
const TEMP_ENTRY = new RegExp(String.raw`^${TEMP_DIRECTORY}\/[A-Za-z0-9_][A-Za-z0-9_.-]*$`);
const RM_FLAGS = /^-[rRf]+$/;
// A whole home or system folder, or a path the shell fills in at run time.
const SWEEPING_PATHS = [
  /^\/+\.?\*?$/,
  /^\/(?:bin|boot|dev|etc|lib\w*|opt|proc|root|run|sbin|srv|sys|usr|var(?!\/tmp\/))(?:\/|$)/,
  /^\/(?:config|home(?:\/[^/]+)?|media|mnt)\/*\*?$/,
  /^~\/*\*?$/,
  /[$`]/,
];
// Everything in the working folder, whatever it is.
const SWEEPING_HERE = /^(?:\.{1,2}\/*|\.{0,2}\/?\*)$/;

function sweeping(path: string, here = true): boolean {
  const home = path.replace(/^\$(?:HOME\b|\{HOME\})/, "~");
  return SWEEPING_PATHS.some((pattern) => pattern.test(home)) || (here && SWEEPING_HERE.test(home));
}

// What a step destroys inside the computer: a sweeping or irreversible deletion always asks in
// Auto, and a local one is the judge's. Clearing a named entry in a temp directory is scratch work.
function deletion(facts: RiskFacts): "sweeping" | "local" | undefined {
  if (facts.operation === "files_delete") return "local";
  if (facts.operation !== "shell" || !facts.command) return undefined;
  const command = facts.command.replace(
    new RegExp(
      String.raw`^\s*cd\s+(${TEMP_DIRECTORY})\s*(?:&&|;)\s*rm\s+(?:-[rRf]+\s+)?(?:--\s+)?([A-Za-z0-9_][A-Za-z0-9_.-]*)(?=\s*(?:;|&&|$))`,
    ),
    "true",
  );
  let found: "sweeping" | "local" | undefined;
  for (const { runs } of commandLines(command))
    for (const words of runs) {
      const effect = destroyed(words);
      if (effect === "sweeping") return effect;
      found ??= effect;
    }
  return found;
}

function destroyed(words: readonly string[]): "sweeping" | "local" | undefined {
  const name = words[0]?.replace(/^.*\//, "") ?? "";
  const args = words.slice(1);
  if (/\.(?:rmtree|unlink|remove|rmdir)\(/.test(name)) return "local";
  if (/^(?:drop|truncate)$/i.test(name) && /^(?:table|database)$/i.test(args[0] ?? ""))
    return "sweeping";
  if (name === "rm" || name === "unlink") {
    if (args.includes("--no-preserve-root")) return "sweeping";
    const paths = args.filter((arg) => !RM_FLAGS.test(arg) && arg !== "--");
    if (paths.some((path) => sweeping(path))) return "sweeping";
    return paths.length > 0 && paths.every((path) => TEMP_ENTRY.test(path)) ? undefined : "local";
  }
  if (name === "find" && args.includes("-delete")) {
    const roots = args.slice(
      0,
      args.findIndex((arg) => /^[-(!]/.test(arg)),
    );
    return roots.some((root) => sweeping(root, false)) ? "sweeping" : "local";
  }
  if (/^(?:mkfs(?:\.[a-z0-9]+)?|wipefs)$/.test(name)) return "sweeping";
  if (/^(?:rmdir|shred)$/.test(name)) return "local";
  if (name === "diskutil") return /^erase/.test(args[0] ?? "") ? "sweeping" : undefined;
  // Reading with dd isn't destructive; an explicit output may overwrite data or a disk.
  if (name === "dd") {
    const output = args.find((arg) => arg.startsWith("of="));
    if (!output || output === "of=/dev/null") return undefined;
    return output.startsWith("of=/dev/") ? "sweeping" : "local";
  }
  if (name === "git") {
    let index = 0;
    while (index < args.length && args[index]?.startsWith("-")) {
      if (["-C", "-c", "--git-dir", "--work-tree"].includes(args[index] ?? "")) index++;
      index++;
    }
    return args[index] === "clean" || (args[index] === "reset" && args.includes("--hard"))
      ? "sweeping"
      : undefined;
  }
  // Inspect program text only when an interpreter or database client executes
  // it. A grep pattern, filename, comment, or printed example is not an action.
  if (/^(?:python[\d.]*|node|perl|ruby|sqlite3|psql|mysql)$/.test(name)) {
    const code = args.join(" ");
    if (/\b(?:drop\s+(?:table|database)|truncate\s+table)\b/i.test(code)) return "sweeping";
    return /\.(?:rmtree|unlink|remove|rmdir)\s*\(/.test(code) ? "local" : undefined;
  }
  return undefined;
}
