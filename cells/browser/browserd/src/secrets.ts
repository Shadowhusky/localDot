import { z as schema } from "zod";
import type { BrowserNative } from "./native.ts";
import { MAX_CDP_MESSAGE_BYTES } from "./pipe.ts";
import type { BrowserDocument, BrowserTargets } from "./targets.ts";

export const MAX_SECRET_NODES = 32_768;
// A page's inline script runs to megabytes (Google's sign-in page, almost one); only the CDP
// message that carries it bounds a snapshot string.
export const snapshotString = schema.string().max(MAX_CDP_MESSAGE_BYTES);
const index = schema.number().int().nonnegative().max(131_071);
const stringIndex = schema.number().int().min(-1).max(131_071);
const nodeId = schema.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const indexes = schema.array(index).max(MAX_SECRET_NODES);
const rareStrings = schema.object({
  index: indexes,
  value: schema.array(stringIndex).max(MAX_SECRET_NODES),
});
const snapshotSchema = schema.object({
  strings: schema.array(snapshotString).max(131_072),
  documents: schema
    .array(
      schema.object({
        nodes: schema.object({
          nodeName: indexes,
          backendNodeId: schema.array(nodeId).max(MAX_SECRET_NODES),
          attributes: schema.array(schema.array(stringIndex).max(256)).max(MAX_SECRET_NODES),
          inputValue: rareStrings,
          textValue: rareStrings,
        }),
      }),
    )
    .min(1)
    .max(256),
});
const focusSchema = schema.object({
  nodes: schema
    .array(
      schema.object({
        backendDOMNodeId: nodeId.optional(),
        properties: schema
          .array(
            schema.object({
              name: schema.string().max(128),
              value: schema.object({ value: schema.unknown().optional() }),
            }),
          )
          .max(256)
          .optional(),
      }),
    )
    .max(MAX_SECRET_NODES),
});

export class BrowserSecretError extends Error {
  constructor(readonly reason: "inspection" | "stale" | "aborted" | "cleanup") {
    super(`Browser secret protection refused: ${reason}`);
  }
}

export interface BrowserSecretMetadata {
  readonly filled: boolean;
  readonly nodeIds: readonly number[];
}

export function verificationField(attributes: ReadonlyMap<string, string>): boolean {
  return (
    /(?:^|\s)one-time-code(?:\s|$)/iu.test(attributes.get("autocomplete") ?? "") ||
    ["name", "id", "aria-label"].some((key) =>
      /(?:passcode|(?:^|[^a-z])(?:otp|totp|2fa|mfa|pin)(?:[^a-z]|$)|(?:one[-_ ]?time|verification|security|auth|recovery|backup)[-_ ]?code)/iu.test(
        attributes.get(key) ?? "",
      ),
    )
  );
}

function sensitive(tag: string, attributes: ReadonlyMap<string, string>): boolean {
  if (
    tag === "INPUT" &&
    [
      "button",
      "submit",
      "reset",
      "checkbox",
      "radio",
      "file",
      "image",
      "range",
      "color",
      "date",
      "datetime-local",
      "month",
      "week",
      "time",
    ].includes(attributes.get("type")?.toLowerCase() ?? "")
  )
    return false;
  if (attributes.get("type")?.toLowerCase() === "password") return true;
  if (
    attributes
      .get("autocomplete")
      ?.toLowerCase()
      .split(/\s+/u)
      .some((token) => ["current-password", "new-password", "one-time-code"].includes(token))
  )
    return true;
  return (
    verificationField(attributes) ||
    ["name", "id", "aria-label"].some((key) => /password/iu.test(attributes.get(key) ?? ""))
  );
}

export function secretMetadata(raw: unknown): BrowserSecretMetadata {
  try {
    const snapshot = snapshotSchema.parse(raw);
    const valueAt = (position: number): string => {
      if (position === -1) return "";
      const value = snapshot.strings[position];
      if (value === undefined) throw new BrowserSecretError("inspection");
      return value;
    };
    const secrets = new Set<number>();
    const seen = new Set<number>();
    let filled = false;
    let total = 0;
    let attributeCount = 0;
    for (const document of snapshot.documents) {
      const nodes = document.nodes;
      const length = nodes.nodeName.length;
      total += length;
      if (
        length === 0 ||
        total > MAX_SECRET_NODES ||
        nodes.backendNodeId.length !== length ||
        nodes.attributes.length !== length
      )
        throw new BrowserSecretError("inspection");
      const present = new Set<number>();
      for (const column of [nodes.inputValue, nodes.textValue]) {
        if (column.index.length !== column.value.length) throw new BrowserSecretError("inspection");
        let previous = -1;
        for (let position = 0; position < column.index.length; position += 1) {
          const node = column.index[position];
          const value = column.value[position];
          if (node === undefined || value === undefined || node <= previous || node >= length)
            throw new BrowserSecretError("inspection");
          previous = node;
          if (valueAt(value).length !== 0) present.add(node);
        }
      }
      for (let position = 0; position < length; position += 1) {
        const name = nodes.nodeName[position];
        const backendNodeId = nodes.backendNodeId[position];
        const pairs = nodes.attributes[position];
        if (name === undefined || backendNodeId === undefined || !pairs || pairs.length % 2 !== 0)
          throw new BrowserSecretError("inspection");
        if (seen.has(backendNodeId)) throw new BrowserSecretError("inspection");
        seen.add(backendNodeId);
        attributeCount += pairs.length;
        if (attributeCount > 262_144) throw new BrowserSecretError("inspection");
        const tag = valueAt(name).toUpperCase();
        const attributes = new Map<string, string>();
        for (let offset = 0; offset < pairs.length; offset += 2) {
          const keyIndex = pairs[offset];
          const valueIndex = pairs[offset + 1];
          if (keyIndex === undefined || valueIndex === undefined)
            throw new BrowserSecretError("inspection");
          const key = valueAt(keyIndex).toLowerCase();
          if (!key || attributes.has(key)) throw new BrowserSecretError("inspection");
          attributes.set(key, valueAt(valueIndex));
        }
        if (!["INPUT", "TEXTAREA"].includes(tag) || !sensitive(tag, attributes)) continue;
        secrets.add(backendNodeId);
        if (present.has(position) || (attributes.get("value") ?? "").length !== 0) filled = true;
      }
    }
    return Object.freeze({ filled, nodeIds: Object.freeze([...secrets]) });
  } catch {
    throw new BrowserSecretError("inspection");
  }
}

type SecretTargets = Pick<BrowserTargets, "tabs" | "documents" | "command" | "check" | "reload">;

export class BrowserSecrets {
  constructor(
    private readonly targets: SecretTargets,
    private readonly native: Pick<BrowserNative, "command">,
  ) {}

  #check(signal: AbortSignal, documents: readonly BrowserDocument[] = []): void {
    if (signal.aborted) throw new BrowserSecretError("aborted");
    for (const document of documents) this.targets.check(document);
  }

  async clearSelections(signal: AbortSignal): Promise<void> {
    this.#check(signal);
    await this.native.command("clearSelections", {}, signal);
    this.#check(signal);
  }

  async inspect(document: BrowserDocument, signal: AbortSignal): Promise<BrowserSecretMetadata> {
    this.#check(signal, [document]);
    const raw = await this.targets.command(
      document,
      "DOMSnapshot.captureSnapshot",
      { computedStyles: [] },
      signal,
    );
    this.#check(signal, [document]);
    const result = secretMetadata(raw);
    this.#check(signal, [document]);
    return result;
  }

  async secretPages(signal: AbortSignal): Promise<readonly string[]> {
    this.#check(signal);
    const tabs = this.targets.tabs();
    if (tabs.length > 256 || tabs.some((tab) => !tab.ready)) throw new BrowserSecretError("stale");
    const documents = tabs.flatMap((tab) => this.targets.documents(tab.id));
    const pages = new Set<string>();
    for (const document of documents) {
      if ((await this.inspect(document, signal)).filled) pages.add(document.tabId);
      this.#check(signal, documents);
    }
    const current = this.targets.tabs();
    if (
      current.length !== tabs.length ||
      current.some((tab, position) => !tab.ready || tab.id !== tabs[position]?.id)
    )
      throw new BrowserSecretError("stale");
    this.#check(signal, documents);
    return Object.freeze([...pages]);
  }

  async secretFocused(tabId: string, signal: AbortSignal): Promise<boolean> {
    this.#check(signal);
    const documents = this.targets.documents(tabId);
    let found = false;
    for (const document of documents) {
      const metadata = await this.inspect(document, signal);
      const raw = await this.targets.command(document, "Accessibility.getFullAXTree", {}, signal);
      this.#check(signal, documents);
      const parsed = focusSchema.safeParse(raw);
      if (!parsed.success) throw new BrowserSecretError("inspection");
      for (const node of parsed.data.nodes) {
        if (
          !node.properties?.some(
            (property) => property.name === "focused" && property.value.value === true,
          )
        )
          continue;
        if (!node.backendDOMNodeId) throw new BrowserSecretError("inspection");
        if (metadata.nodeIds.includes(node.backendDOMNodeId)) found = true;
      }
    }
    this.#check(signal, documents);
    return found;
  }

  async reload(tabId: string, signal: AbortSignal): Promise<void> {
    this.#check(signal);
    try {
      await this.targets.reload(tabId, signal);
    } catch {
      throw new BrowserSecretError(signal.aborted ? "aborted" : "cleanup");
    }
    this.#check(signal, this.targets.documents(tabId));
  }
}
