import { lstatSync } from "node:fs";
import {
  type ActionClass,
  type AlwaysOption,
  type AlwaysScope,
  AutonomyRule,
  type RuleChange,
  ulid,
} from "@localdot/protocol";
import { z } from "zod";
import { PrivateFiles } from "../private-files.ts";

export const MAX_RULES = 200;
const FILE = "rules.json";
const MAX_BYTES = 256 * 1024;
const UNREADABLE = "Saved Always allow choices could not be read, so none are in use.";

// How far "Always allow" may relax each class from ask to act. Purchases and credentials never;
// uploads and unclear steps only within the task.
export const ALWAYS_SCOPES: Readonly<Record<ActionClass, readonly AlwaysScope[]>> = {
  reading: ["task", "always"],
  browsing: ["task", "site", "always"],
  computer: ["task", "app", "always"],
  download_execute: ["task", "always"],
  memory: ["task", "always"],
  send: ["task", "site"],
  post: ["task", "site"],
  delete: ["task", "site"],
  system_settings: ["task", "site"],
  purchase: [],
  upload: ["task"],
  credentials: [],
  unknown: ["task"],
};
export interface Place {
  readonly site?: string;
  readonly app?: string;
}

const Rule = AutonomyRule.refine((rule) => ALWAYS_SCOPES[rule.actionClass].includes(rule.scope));
const RulesFile = z
  .strictObject({ version: z.literal(1), rules: z.array(Rule).max(MAX_RULES) })
  .refine(({ rules }) => new Set(rules.map((rule) => rule.id)).size === rules.length);

export class RuleError extends Error {
  constructor(
    readonly status: 409,
    message: string,
  ) {
    super(message);
    this.name = "RuleError";
  }
}

// The user's saved rules, read from disk on every decision so a removed rule tightens the very
// next step. An unreadable file relaxes nothing and blocks nothing.
export class RulesStore {
  #files: PrivateFiles | undefined;
  constructor(
    private readonly home: string,
    private readonly now: () => number = Date.now,
  ) {}
  #read(): AutonomyRule[] {
    if (!lstatSync(this.home, { throwIfNoEntry: false })) return [];
    this.#files ??= new PrivateFiles(this.home);
    const text = this.#files.text(FILE, MAX_BYTES);
    return text === undefined ? [] : RulesFile.parse(JSON.parse(text)).rules;
  }
  #current(): AutonomyRule[] {
    try {
      return this.#read();
    } catch {
      throw new RuleError(409, UNREADABLE);
    }
  }
  #write(rules: AutonomyRule[]): void {
    const document = RulesFile.parse({ version: 1, rules });
    this.#files ??= new PrivateFiles(this.home);
    this.#files.write(FILE, `${JSON.stringify(document, null, 2)}\n`);
  }
  list(): { rules: AutonomyRule[]; error?: string } {
    try {
      return { rules: this.#read() };
    } catch {
      return { rules: [], error: UNREADABLE };
    }
  }
  matches(actionClass: ActionClass, place: Place): boolean {
    return this.list().rules.some(
      (rule) =>
        rule.actionClass === actionClass &&
        ALWAYS_SCOPES[actionClass].includes(rule.scope) &&
        (rule.scope === "always" ||
          (rule.scope === "site" && rule.site === place.site) ||
          (rule.scope === "app" && rule.app === place.app)),
    );
  }
  add(actionClass: ActionClass, option: AlwaysOption, createdFrom: string): AutonomyRule {
    const rules = this.#current();
    const same = rules.find(
      (rule) =>
        rule.actionClass === actionClass &&
        rule.scope === option.scope &&
        rule.site === option.site &&
        rule.app === option.app,
    );
    if (same) return same;
    if (rules.length >= MAX_RULES)
      throw new RuleError(409, `You can keep up to ${MAX_RULES} Always allow choices.`);
    const rule = Rule.parse({
      id: ulid(),
      behavior: "act",
      actionClass,
      scope: option.scope,
      ...(option.site === undefined ? {} : { site: option.site }),
      ...(option.app === undefined ? {} : { app: option.app }),
      label: option.label,
      createdAt: this.now(),
      createdFrom,
    });
    this.#write([...rules, rule]);
    return rule;
  }
  remove(id: string): AutonomyRule | undefined {
    const rules = this.#current();
    const rule = rules.find((candidate) => candidate.id === id);
    if (rule) this.#write(rules.filter((candidate) => candidate !== rule));
    return rule;
  }
}

export function ruleChange({ id, scope, actionClass, label, site, app }: AutonomyRule): RuleChange {
  return {
    id,
    scope,
    actionClass,
    label,
    ...(site === undefined ? {} : { site }),
    ...(app === undefined ? {} : { app }),
  };
}
