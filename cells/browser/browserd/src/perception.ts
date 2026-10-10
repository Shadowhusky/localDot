import { createHash } from "node:crypto";
import {
  type BrowserReadResult,
  checkedOf,
  type PageElement,
  type Target,
} from "@localdot/protocol";
import { z as schema } from "zod";
import type { BrowserCaptureMask, BrowserMaskRect } from "./capture-mask.ts";
import type { BrowserGeometrySnapshot } from "./geometry.ts";
import { MAX_SECRET_NODES, secretMetadata, snapshotString } from "./secrets.ts";

const position = schema.number().int().min(0).max(131071);
const stringIndex = schema.number().int().min(-1).max(131071);
const backend = schema.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const coordinate = schema.number().finite().min(-0x7ffffffe).max(0x7ffffffe);
const extent = schema.number().finite().min(0).max(0x7ffffffe);
const rectangle = schema.tuple([coordinate, coordinate, extent, extent]);
const snapshotSchema = schema.object({
  strings: schema.array(snapshotString).max(131072),
  documents: schema
    .array(
      schema.object({
        frameId: position,
        documentURL: position.optional(),
        title: stringIndex.optional(),
        scrollOffsetX: coordinate,
        scrollOffsetY: coordinate,
        nodes: schema.object({
          nodeName: schema.array(position).max(MAX_SECRET_NODES),
          nodeValue: schema.array(stringIndex).max(MAX_SECRET_NODES).optional(),
          parentIndex: schema
            .array(schema.number().int().min(-1).max(MAX_SECRET_NODES))
            .max(MAX_SECRET_NODES),
          backendNodeId: schema.array(backend).max(MAX_SECRET_NODES),
          attributes: schema
            .array(schema.array(schema.number().int().min(-1).max(131071)).max(256))
            .max(MAX_SECRET_NODES),
        }),
        layout: schema.object({
          nodeIndex: schema.array(position).max(MAX_SECRET_NODES),
          bounds: schema.array(rectangle).max(MAX_SECRET_NODES),
        }),
      }),
    )
    .min(1)
    .max(256),
});
const axSchema = schema.object({
  nodes: schema
    .array(
      schema.object({
        ignored: schema.boolean(),
        backendDOMNodeId: backend.optional(),
        role: schema.object({ value: schema.string().max(128) }).optional(),
        name: schema.object({ value: schema.string().max(8192) }).optional(),
        properties: schema
          .array(
            schema.object({
              name: schema.string().max(128),
              value: schema.object({ value: schema.unknown().optional() }),
            }),
          )
          .max(128)
          .optional(),
      }),
    )
    .max(MAX_SECRET_NODES),
});
const roles = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "tab",
  "menuitem",
  "option",
  "heading",
  "StaticText",
  "image",
  "listitem",
]);

// What a person can click, type into or choose: listed with refs when the page is read.
const interactive = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "tab",
  "menuitem",
  "option",
]);
const MAX_ELEMENTS = 300;

export class BrowserPerceptionError extends Error {
  constructor(readonly reason: "metadata" | "secret" | "geometry") {
    super(`Browser perception refused: ${reason}`);
  }
}

export interface BrowserProjection {
  readonly mask: BrowserCaptureMask;
  readonly targets: readonly Target[];
  readonly signature: string;
  readonly focused: Target | null;
  readonly page?: BrowserReadResult;
  targetForNode(backendNodeId: number): Target | null;
  // The target listed for exactly this node.
  targetOf(backendNodeId: number): Target | null;
}

function text(value: string): string {
  return [...value.replace(/[\p{Cc}\p{Cf}]/gu, " ")].slice(0, 64).join("");
}

function pixels(
  bounds: BrowserMaskRect,
  geometry: BrowserGeometrySnapshot,
  content: BrowserMaskRect,
  padding: number,
): BrowserMaskRect | undefined {
  const left = Math.max(
    content[0],
    Math.floor(geometry.content[0] + bounds[0] - geometry.scrollX * geometry.factor) - padding,
  );
  const top = Math.max(
    content[1],
    Math.floor(geometry.content[1] + bounds[1] - geometry.scrollY * geometry.factor) - padding,
  );
  const right = Math.min(
    content[0] + content[2],
    Math.ceil(geometry.content[0] + bounds[0] + bounds[2] - geometry.scrollX * geometry.factor) +
      padding,
  );
  const bottom = Math.min(
    content[1] + content[3],
    Math.ceil(geometry.content[1] + bounds[1] + bounds[3] - geometry.scrollY * geometry.factor) +
      padding,
  );
  if (right <= left || bottom <= top || bounds[2] === 0 || bounds[3] === 0) return undefined;
  return Object.freeze([left, top, right - left, bottom - top]);
}

// Page identity is useful; credentials, fragments and query tokens are not public metadata.
function pageAddress(raw: string): URL {
  const url = new URL(raw);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url;
}

export function projectBrowser(
  rawSnapshot: unknown,
  rawAX: unknown,
  rootFrame: string,
  geometry: BrowserGeometrySnapshot,
  scale: 1 | 2,
  readMaxChars?: number,
): BrowserProjection {
  try {
    if (scale !== 1 && scale !== 2) throw new BrowserPerceptionError("geometry");
    const secret = secretMetadata(rawSnapshot);
    if (secret.filled) throw new BrowserPerceptionError("secret");
    const snapshot = snapshotSchema.parse(rawSnapshot);
    const accessibility = axSchema.parse(rawAX);
    const root = snapshot.documents[0];
    const stringAt = (index: number): string => {
      const value = snapshot.strings[index];
      if (value === undefined) throw new BrowserPerceptionError("metadata");
      return value;
    };
    if (
      !root ||
      stringAt(root.frameId) !== rootFrame ||
      Math.abs(root.scrollOffsetX - geometry.scrollX * geometry.factor) > 0.01 ||
      Math.abs(root.scrollOffsetY - geometry.scrollY * geometry.factor) > 0.01
    )
      throw new BrowserPerceptionError("geometry");
    const left = Math.ceil(geometry.content[0]);
    const top = Math.ceil(geometry.content[1]);
    const right = Math.floor(
      Math.min(
        geometry.content[0] + geometry.content[2],
        geometry.content[0] + geometry.width * geometry.factor,
      ),
    );
    const bottom = Math.floor(
      Math.min(
        geometry.content[1] + geometry.content[3],
        geometry.content[1] + geometry.height * geometry.factor,
      ),
    );
    if (
      left < 0 ||
      top < 0 ||
      right > 1280 * scale ||
      bottom > 800 * scale ||
      right <= left ||
      bottom <= top
    )
      throw new BrowserPerceptionError("geometry");
    const content: BrowserMaskRect = Object.freeze([left, top, right - left, bottom - top]);
    const nodes = root.nodes;
    const length = nodes.nodeName.length;
    if (
      nodes.parentIndex.length !== length ||
      nodes.backendNodeId.length !== length ||
      nodes.attributes.length !== length ||
      root.layout.nodeIndex.length !== root.layout.bounds.length
    )
      throw new BrowserPerceptionError("metadata");
    const protectedIds = new Set(secret.nodeIds);
    const blocked = new Set<number>();
    const editable = new Set<number>();
    const embedded = new Set<number>();
    const unreadable = new Set<number>();
    const positions = new Map<number, number>();
    const namedNodes = new Map<string, number[]>();
    const nameReferences = new Map<number, string[]>();
    // What a field's author named it: its aria-label, or a <label for> its id.
    const ariaLabels = new Map<number, string>();
    const fieldIds = new Map<number, string>();
    const labelsFor = new Map<string, number[]>();
    const labelReferences = new Map<number, string>();
    // Each node's nearest <label>, itself included.
    const labelOf = new Map<number, number>();
    let referenceCount = 0;
    for (let offset = 0; offset < length; offset += 1) {
      const parent = nodes.parentIndex[offset];
      const nodeName = nodes.nodeName[offset];
      const nodeId = nodes.backendNodeId[offset];
      const attributes = nodes.attributes[offset];
      if (
        parent === undefined ||
        nodeName === undefined ||
        nodeId === undefined ||
        !attributes ||
        parent >= offset ||
        (offset === 0 ? parent !== -1 : parent < 0) ||
        attributes.length % 2 !== 0
      )
        throw new BrowserPerceptionError("metadata");
      const pairs = new Map<string, string>();
      for (let item = 0; item < attributes.length; item += 2) {
        const keyIndex = attributes[item];
        const valueIndex = attributes[item + 1];
        if (keyIndex === undefined || valueIndex === undefined)
          throw new BrowserPerceptionError("metadata");
        const key = stringAt(keyIndex).toLowerCase();
        if (!key || pairs.has(key)) throw new BrowserPerceptionError("metadata");
        pairs.set(key, valueIndex === -1 ? "" : stringAt(valueIndex));
      }
      const tag = stringAt(nodeName).toUpperCase();
      const htmlId = pairs.get("id");
      if (htmlId) {
        const members = namedNodes.get(htmlId) ?? [];
        members.push(offset);
        namedNodes.set(htmlId, members);
      }
      const references = (pairs.get("aria-labelledby") ?? "").split(/\s+/u).filter(Boolean);
      referenceCount += references.length;
      if (referenceCount > MAX_SECRET_NODES) throw new BrowserPerceptionError("metadata");
      if (references.length) nameReferences.set(offset, references);
      if (
        ["INPUT", "TEXTAREA", "SELECT"].includes(tag) ||
        (pairs.has("contenteditable") && pairs.get("contenteditable")?.toLowerCase() !== "false")
      ) {
        editable.add(offset);
        const aria = pairs.get("aria-label");
        if (aria) ariaLabels.set(offset, aria);
        if (htmlId) fieldIds.set(offset, htmlId);
      }
      const labelled = tag === "LABEL" ? offset : labelOf.get(parent);
      if (labelled !== undefined) labelOf.set(offset, labelled);
      const labelFor = tag === "LABEL" ? pairs.get("for") : undefined;
      if (labelFor) {
        labelReferences.set(offset, labelFor);
        const labels = labelsFor.get(labelFor) ?? [];
        labels.push(offset);
        labelsFor.set(labelFor, labels);
      }
      if (["IFRAME", "FRAME", "OBJECT", "EMBED", "CANVAS"].includes(tag)) embedded.add(offset);
      if (
        editable.has(offset) ||
        embedded.has(offset) ||
        protectedIds.has(nodeId) ||
        blocked.has(parent)
      )
        blocked.add(offset);
      if (
        blocked.has(offset) ||
        unreadable.has(parent) ||
        ["HEAD", "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(tag)
      )
        unreadable.add(offset);
      positions.set(nodeId, offset);
    }
    const dependents = new Map<number, Set<number>>();
    const connectName = (source: number, consumer: number) => {
      const consumers = dependents.get(source) ?? new Set<number>();
      consumers.add(consumer);
      dependents.set(source, consumers);
    };
    for (let offset = 1; offset < length; offset += 1)
      connectName(offset, nodes.parentIndex[offset] as number);
    let dependencyCount = length;
    for (const [consumer, references] of nameReferences) {
      for (const reference of references) {
        for (const source of namedNodes.get(reference) ?? []) {
          dependencyCount += 1;
          if (dependencyCount > MAX_SECRET_NODES * 2) throw new BrowserPerceptionError("metadata");
          connectName(source, consumer);
        }
      }
    }
    const unsafeNames = new Set(blocked);
    const nameQueue = [...blocked];
    for (let offset = 0; offset < nameQueue.length; offset += 1) {
      for (const consumer of dependents.get(nameQueue[offset] as number) ?? []) {
        if (unsafeNames.has(consumer)) continue;
        unsafeNames.add(consumer);
        nameQueue.push(consumer);
      }
    }
    const labelText = new Map<number, string>();
    if (nodes.nodeValue?.length === length)
      for (const [offset, label] of labelOf) {
        const valueIndex = nodes.nodeValue[offset] ?? -1;
        if (
          valueIndex === -1 ||
          unreadable.has(offset) ||
          stringAt(nodes.nodeName[offset] as number) !== "#text"
        )
          continue;
        const sofar = labelText.get(label) ?? "";
        if (sofar.length < 256) labelText.set(label, `${sofar} ${stringAt(valueIndex)}`);
      }
    // A field is named by its author's label, never by its value: a <label for> counts only when
    // it is the field's one label, holds no field or secret, and the id is the field's alone.
    const fieldName = (offset: number): string => {
      const aria = ariaLabels.get(offset);
      if (aria) return aria;
      const id = fieldIds.get(offset);
      const labels = id && namedNodes.get(id)?.length === 1 ? labelsFor.get(id) : undefined;
      const label = labels?.length === 1 ? labels[0] : undefined;
      if (label === undefined || unsafeNames.has(label) || unreadable.has(label)) return "";
      return labelText.get(label) ?? "";
    };
    const boxes = new Map<number, BrowserMaskRect>();
    const redactions: BrowserMaskRect[] = [];
    for (let item = 0; item < root.layout.nodeIndex.length; item += 1) {
      const offset = root.layout.nodeIndex[item];
      const bounds = root.layout.bounds[item];
      if (offset === undefined || offset >= length || !bounds)
        throw new BrowserPerceptionError("metadata");
      const previous = boxes.get(offset);
      if (previous) {
        const unionLeft = Math.min(previous[0], bounds[0]);
        const unionTop = Math.min(previous[1], bounds[1]);
        boxes.set(offset, [
          unionLeft,
          unionTop,
          Math.max(previous[0] + previous[2], bounds[0] + bounds[2]) - unionLeft,
          Math.max(previous[1] + previous[3], bounds[1] + bounds[3]) - unionTop,
        ]);
      } else boxes.set(offset, bounds);
      if (!blocked.has(offset)) continue;
      const region = pixels(bounds, geometry, content, 4 * scale);
      if (region) redactions.push(region);
      if (redactions.length > 256) throw new BrowserPerceptionError("metadata");
    }
    let page: BrowserReadResult | undefined;
    if (readMaxChars !== undefined) {
      if (
        !Number.isSafeInteger(readMaxChars) ||
        readMaxChars < 500 ||
        readMaxChars > 100000 ||
        root.documentURL === undefined ||
        root.title === undefined ||
        nodes.nodeValue?.length !== length
      )
        throw new BrowserPerceptionError("metadata");
      const rawURL = stringAt(root.documentURL);
      const url = pageAddress(rawURL);
      if (!["http:", "https:"].includes(url.protocol) && rawURL !== "about:blank")
        throw new BrowserPerceptionError("metadata");
      const clean = (value: string) =>
        value
          .replace(/[\p{Cc}\p{Cf}]/gu, " ")
          .replace(/\s+/gu, " ")
          .trim();
      let truncated = false;
      const appendBounded = (current: string, addition: string, limit: number) => {
        if (!addition) return current;
        const next = (current ? "\n" : "") + addition;
        if (current.length + next.length <= limit) return current + next;
        truncated = true;
        let available = next.slice(0, Math.max(0, limit - current.length));
        if (/[\uD800-\uDBFF]$/.test(available)) available = available.slice(0, -1);
        return current + available;
      };
      let pageText = "",
        outline = "";
      for (let offset = 0; offset < length; offset++) {
        const valueIndex = nodes.nodeValue[offset];
        if (valueIndex === undefined) throw new BrowserPerceptionError("metadata");
        const value = valueIndex === -1 ? "" : stringAt(valueIndex);
        const box = boxes.get(offset);
        if (
          unreadable.has(offset) ||
          !box ||
          box[2] <= 0 ||
          box[3] <= 0 ||
          stringAt(nodes.nodeName[offset] as number) !== "#text"
        )
          continue;
        pageText = appendBounded(pageText, clean(value), readMaxChars);
      }
      const seenOutline = new Set<number>();
      for (const node of accessibility.nodes) {
        const id = node.backendDOMNodeId,
          role = node.role?.value;
        if (
          !id ||
          node.ignored ||
          !role ||
          !roles.has(role) ||
          role === "StaticText" ||
          seenOutline.has(id)
        )
          continue;
        seenOutline.add(id);
        const offset = positions.get(id),
          box = offset === undefined ? undefined : boxes.get(offset);
        if (
          offset === undefined ||
          unreadable.has(offset) ||
          unsafeNames.has(offset) ||
          !box ||
          box[2] <= 0 ||
          box[3] <= 0
        )
          continue;
        outline = appendBounded(outline, `${role} ${clean(node.name?.value ?? "")}`.trim(), 20000);
      }
      const title = appendBounded("", clean(root.title === -1 ? "" : stringAt(root.title)), 2048);
      page = Object.freeze({
        url: url.href,
        title,
        text: pageText,
        outline,
        truncated,
      });
    }
    const rawAddress = root.documentURL === undefined ? undefined : stringAt(root.documentURL);
    const address =
      rawAddress !== undefined && URL.canParse(rawAddress) ? pageAddress(rawAddress) : undefined;
    // Every target names its page, so a step can be allowed on its site.
    const pageURL =
      address && ["http:", "https:"].includes(address.protocol)
        ? address.href.length <= 2048
          ? address.href
          : address.origin
        : undefined;
    const targets: Target[] = [];
    const projected = new Map<number, Target>();
    const elements: PageElement[] = [];
    let focused: Target | null = null;
    const seen = new Set<number>();
    for (const node of accessibility.nodes) {
      const nodeId = node.backendDOMNodeId;
      const role = node.role?.value;
      if (node.ignored || !nodeId || !role || !roles.has(role)) continue;
      const offset = positions.get(nodeId);
      if (offset === undefined || seen.has(nodeId)) continue;
      seen.add(nodeId);
      if (blocked.has(offset) && !editable.has(offset)) continue;
      const bounds = boxes.get(offset);
      const region = bounds ? pixels(bounds, geometry, content, 0) : undefined;
      if (!region) continue;
      const isSecret = protectedIds.has(nodeId);
      const property = (key: string) =>
        node.properties?.find((item) => item.name === key)?.value.value;
      const checked = checkedOf(property("checked"));
      const name = isSecret
        ? "Protected field"
        : editable.has(offset)
          ? text(fieldName(offset).replace(/\s+/gu, " ").trim()).trim() || "Input field"
          : unsafeNames.has(offset)
            ? ""
            : text(node.name?.value ?? "");
      targets.push(
        Object.freeze({
          point: Object.freeze({
            x: (region[0] + region[2] / 2) / scale,
            y: (region[1] + region[3] / 2) / scale,
          }),
          bbox: Object.freeze({
            x: region[0] / scale,
            y: region[1] / scale,
            w: region[2] / scale,
            h: region[3] / scale,
          }),
          source: "ax" as const,
          role: text(role),
          name,
          app: "Chromium",
          ...(pageURL ? { url: pageURL } : {}),
          secret: isSecret,
          ...(checked ? { checked } : {}),
        }),
      );
      if (targets.length > 512) throw new BrowserPerceptionError("metadata");
      const target = targets.at(-1);
      if (!target) throw new BrowserPerceptionError("metadata");
      projected.set(nodeId, target);
      if (page && interactive.has(role) && elements.length < MAX_ELEMENTS && target.bbox) {
        const expanded = property("expanded");
        elements.push(
          Object.freeze({
            ref: `e${nodeId}`,
            role: target.role ?? role,
            name: target.name ?? "",
            box: target.bbox,
            ...(checked ? { checked } : {}),
            ...(property("disabled") === true ? { disabled: true as const } : {}),
            ...(typeof expanded === "boolean" ? { expanded } : {}),
            ...(isSecret ? { secret: true as const } : {}),
          }),
        );
      }
      if (
        node.properties?.some(
          (property) => property.name === "focused" && property.value.value === true,
        )
      ) {
        if (focused) throw new BrowserPerceptionError("metadata");
        focused = target;
      }
    }
    const mask: BrowserCaptureMask = Object.freeze({
      width: scale === 1 ? 1280 : 2560,
      height: scale === 1 ? 800 : 1600,
      content,
      redactions: Object.freeze(redactions),
    });
    const signature = createHash("sha256")
      .update(
        JSON.stringify({
          mask,
          protectedIds: [...protectedIds].sort((first, second) => first - second),
          targets,
          focused,
        }),
      )
      .digest("hex");
    // Clicking a radio/checkbox's visible HTML label activates its input, even when
    // the input itself is a tiny styled control. Resolve that native association from
    // the current snapshot, not the model's intent or arbitrary nearby page text.
    const labelControls = new Map<number, Target[]>();
    for (const [nodeId, target] of projected) {
      if (target.role !== "radio" && target.role !== "checkbox") continue;
      const offset = positions.get(nodeId);
      if (offset === undefined || !editable.has(offset)) continue;
      const id = fieldIds.get(offset);
      const wrapped = labelOf.get(offset);
      const labels = new Set([
        ...(id && namedNodes.get(id)?.length === 1 ? (labelsFor.get(id) ?? []) : []),
        ...(wrapped !== undefined && !labelReferences.has(wrapped) ? [wrapped] : []),
      ]);
      for (const label of labels) {
        if (blocked.has(label)) continue;
        const controls = labelControls.get(label) ?? [];
        controls.push(target);
        labelControls.set(label, controls);
      }
    }
    const targetForNode = (nodeId: number): Target | null => {
      let offset = positions.get(nodeId);
      while (offset !== undefined && offset >= 0) {
        const currentId = nodes.backendNodeId[offset];
        if (currentId === undefined) return null;
        const target = projected.get(currentId);
        if (target) return target;
        if (blocked.has(offset)) return null;
        const controls = labelControls.get(offset);
        if (controls?.length === 1) {
          const control = controls[0];
          const bounds = boxes.get(offset);
          const region = bounds && pixels(bounds, geometry, content, 0);
          if (control && region)
            return Object.freeze({
              ...control,
              bbox: Object.freeze({
                x: region[0] / scale,
                y: region[1] / scale,
                w: region[2] / scale,
                h: region[3] / scale,
              }),
              point: Object.freeze({
                x: (region[0] + region[2] / 2) / scale,
                y: (region[1] + region[3] / 2) / scale,
              }),
            });
        }
        offset = nodes.parentIndex[offset];
      }
      return null;
    };
    return Object.freeze({
      mask,
      targets: Object.freeze(targets),
      signature,
      focused,
      targetForNode,
      targetOf: (nodeId: number) => projected.get(nodeId) ?? null,
      ...(page ? { page: Object.freeze({ ...page, elements }) } : {}),
    });
  } catch (error) {
    if (error instanceof BrowserPerceptionError) throw error;
    throw new BrowserPerceptionError("metadata");
  }
}
