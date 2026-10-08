import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import {
  type ActionClass,
  type ApprovalRequestDraft,
  type AutonomyMode,
  type AutonomyPolicy,
  ApprovalRequestDraft as DraftSchema,
  AutonomyPolicy as PolicySchema,
  Target,
} from "@localdot/protocol";
export interface NativeTargetFacts {
  source: "ax" | "dom" | "coords" | "som" | "ocr" | "vision";
  fresh: boolean;
  role?: string;
  name?: string;
  url?: string;
  secret?: boolean;
}
export type RiskFacts = {
  operation:
    | "observe"
    | "navigate"
    | "click"
    | "type"
    | "key"
    | "scroll"
    | "wait"
    | "shell"
    | "files_read"
    | "files_write"
    | "files_upload"
    | "files_delete";
  target?: NativeTargetFacts;
  command?: string;
  destination?: string;
};
export type RiskDecision = {
  actionClass: ActionClass;
  mode: AutonomyMode;
  risk: "none" | "medium" | "high";
};
const protectedField =
  /密碼|密码|验证码|驗證碼|支付|付款|信用卡|登入|登录|登錄|AXSecureTextField|password|passcode|one[ -]?time|verification[ -]?code|2fa|captcha|credit[ -]?card|card[ -]?number|security[ -]?code|cvv|expiry|billing|payment|sign[ -]?in|log[ -]?in/i;
const high: readonly [ActionClass, RegExp][] = [
  ["purchase", /\b(buy|pay|purchase|place\s+order|checkout)\b/i],
  ["send", /\b(send|submit\s+message|mail|email)\b/i],
  ["post", /\b(post|publish|share)\b/i],
  ["delete", /\b(delete|remove|trash|erase|discard)\b/i],
  ["download_execute", /\b(install|execute|run\s+download|open\s+download)\b/i],
  ["system_settings", /\b(permission|settings|preferences|allow\s+access)\b/i],
];
function risk(c: ActionClass, policy: AutonomyPolicy): RiskDecision {
  return {
    actionClass: c,
    mode: c === "credentials" ? "handoff" : c === "unknown" ? "ask" : policy[c],
    risk: c === "reading" || c === "browsing" ? "none" : c === "unknown" ? "medium" : "high",
  };
}
function strongest(classes: ActionClass[], policy: AutonomyPolicy): RiskDecision {
  if (classes.length === 0) return risk("unknown", policy);
  const rank = { act: 0, ask: 1, handoff: 2 };
  return classes
    .map((c) => risk(c, policy))
    .reduce((best, next) => (rank[next.mode] > rank[best.mode] ? next : best));
}
function matching(description: string): ActionClass[] {
  return high.filter(([, pattern]) => pattern.test(description)).map(([c]) => c);
}
export function classify(facts: RiskFacts, rawPolicy: AutonomyPolicy): RiskDecision {
  const policy = PolicySchema.parse(rawPolicy);
  if (facts.operation === "observe" || facts.operation === "files_read")
    return risk("reading", policy);
  if (facts.operation === "wait" || facts.operation === "scroll") return risk("browsing", policy);
  if (facts.operation === "files_delete") return risk("delete", policy);
  if (facts.operation === "files_write") return risk("unknown", policy);
  if (facts.operation === "files_upload") {
    const decision = risk("send", policy);
    return { ...decision, mode: decision.mode === "handoff" ? "handoff" : "ask", risk: "high" };
  }
  if (facts.operation === "shell") {
    const command = facts.command ?? "";
    if (protectedField.test(command)) return risk("credentials", policy);
    const classes = matching(command);
    if (/(^|[;&|\s])(?:rm|rmdir|unlink|shred)(?:\s|$)/i.test(command)) classes.push("delete");
    if (/(^|[;&|\s])(?:sudo|systemctl|launchctl|defaults)(?:\s|$)/i.test(command))
      classes.push("system_settings");
    if (/(^|[;&|\s])(?:bash|sh|zsh|python\d*|node|npm|pnpm|pip\d*|chmod)(?:\s|$)/i.test(command))
      classes.push("download_execute");
    const decision = strongest(classes, policy);
    // Regex cannot establish the complete effects of scripts, substitutions or aliases.
    return decision.mode === "act" ? { ...decision, mode: "ask" } : decision;
  }
  if (facts.operation === "navigate") {
    let url: URL;
    try {
      url = new URL(facts.destination ?? "");
    } catch {
      return risk("unknown", policy);
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      return risk("unknown", policy);
    const classes = matching(decodePath(url.pathname));
    if (url.search) classes.push("unknown");
    return strongest(classes.length ? classes : ["browsing"], policy);
  }
  const target = facts.target;
  if (!target?.fresh || !["ax", "dom"].includes(target.source))
    return risk(facts.operation === "type" ? "credentials" : "unknown", policy);
  const description = `${target.role ?? ""}\n${target.name ?? ""}\n${decodePath(safeTargetURL(target.url))}`;
  if (facts.operation === "type" || target.secret || protectedField.test(description))
    return risk("credentials", policy);
  const classes = matching(description);
  if (target.url) {
    try {
      const url = new URL(target.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search)
        classes.push("unknown");
    } catch {
      classes.push("unknown");
    }
  }
  return strongest(classes, policy);
}
function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
export function safeTargetURL(value: string | undefined): string {
  if (!value) return "";
  try {
    const u = new URL(value);
    return ["http:", "https:"].includes(u.protocol) ? `${u.origin}${u.pathname}` : "";
  } catch {
    return "";
  }
}
function canonical(value: unknown, ancestors = new Set<object>()): string {
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint")
    throw new Error("invalid action value");
  if (value === null || typeof value !== "object") {
    const result = JSON.stringify(value);
    if (result === undefined || (typeof value === "number" && !Number.isFinite(value)))
      throw new Error("invalid action value");
    return result;
  }
  if (isProxy(value)) throw new Error("invalid action proxy");
  if (ancestors.has(value)) throw new Error("cyclic action input");
  const next = new Set(ancestors);
  next.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype)
      throw new Error("invalid action array prototype");
    const descriptors = Object.getOwnPropertyDescriptors(value as object);
    const length = descriptors.length;
    if (!length || !Object.hasOwn(length, "value") || length.enumerable)
      throw new Error("invalid action array length");
    const count = length.value as number;
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      Reflect.ownKeys(descriptors).length !== count + 1
    )
      throw new Error("invalid action array shape");
    // Capture and validate every own data slot before serializing any nested value.
    for (let index = 0; index < count; index++) {
      const descriptor = descriptors[index];
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
        throw new Error("invalid action array property");
    }
    let serialized = "[";
    for (let index = 0; index < count; index++) {
      if (index !== 0) serialized += ",";
      serialized += canonical(descriptors[index]?.value, next);
    }
    return `${serialized}]`;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error("invalid action object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string"))
    throw new Error("invalid action key");
  return `{${Object.keys(descriptors)
    .sort()
    .map((k) => {
      const descriptor = descriptors[k];
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
        throw new Error("invalid action property");
      return `${JSON.stringify(k)}:${canonical(descriptor.value, next)}`;
    })
    .join(",")}}`;
}
export function actionDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function nativeRiskFacts(
  operation: "click" | "key" | "type",
  value: Target | undefined,
  fresh: boolean,
): RiskFacts {
  const target = value === undefined ? undefined : Target.parse(value);
  return {
    operation,
    ...(target
      ? {
          target: {
            source: target.source,
            fresh,
            role: target.role,
            name: target.name,
            url: target.url,
            secret:
              target.secret === true ||
              protectedField.test(`${target.role ?? ""} ${target.name ?? ""}`),
          },
        }
      : {}),
  };
}
const titles: Record<ActionClass, string> = {
  reading: "Read information",
  browsing: "Browse information",
  purchase: "Make purchase",
  send: "Send message",
  post: "Publish content",
  delete: "Delete item",
  download_execute: "Run downloaded program",
  system_settings: "Change system settings",
  credentials: "Take control for protected input",
  unknown: "Review action",
};
export function buildApprovalCard(
  facts: RiskFacts,
  decision: RiskDecision,
  redact: (text: string) => string,
): ApprovalRequestDraft {
  const fields: [string, string][] = [];
  const add = (key: string, value: string | undefined) => {
    if (value) fields.push([key, redact(value)]);
  };
  add("Target", facts.target?.name);
  add("App location", safeTargetURL(facts.target?.url));
  add("Web address", facts.destination);
  add("Command", facts.command);
  return DraftSchema.parse({
    actionClass: decision.actionClass,
    risk: decision.risk === "high" ? "high" : "medium",
    title: titles[decision.actionClass],
    fields,
  });
}
