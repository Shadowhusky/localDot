import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import {
  type ActionClass,
  type ApprovalRequestDraft,
  type AutonomyMode,
  ApprovalRequestDraft as DraftSchema,
  type ScreenName,
} from "@localdot/protocol";
export interface NativeTargetFacts {
  source: "ax" | "dom" | "coords" | "som" | "ocr" | "vision";
  fresh: boolean;
  role?: string;
  name?: string;
  app?: string;
  url?: string;
  secret?: boolean;
}
export type RiskFacts = {
  operation:
    | "observe"
    | "navigate"
    | "click"
    | "pointer"
    | "type"
    | "key"
    | "scroll"
    | "wait"
    | "shell"
    | "files_read"
    | "files_write"
    | "files_upload"
    | "files_delete"
    | "memory_write";
  // Filled from the daemon's own session state when the action is decided.
  screen?: ScreenName;
  signedIn?: boolean;
  target?: NativeTargetFacts;
  keys?: readonly string[];
  newline?: boolean;
  command?: string;
  destination?: string;
};
export type RiskDecision = {
  actionClass: ActionClass;
  mode: AutonomyMode;
  risk: "none" | "medium" | "high";
};
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

const titles: Record<ActionClass, string> = {
  reading: "Read information",
  browsing: "Browse websites",
  computer: "Work in its computer",
  purchase: "Buy or pay",
  send: "Send as you",
  post: "Post as you",
  delete: "Delete your online data",
  download_execute: "Run a downloaded program",
  system_settings: "Change account settings",
  memory: "Save to its memory",
  upload: "Upload your files",
  credentials: "Enter a password or code yourself",
  unknown: "Unclear step",
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
