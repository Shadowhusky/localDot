import { z as schema } from "zod";
import {
  type BrowserSignInPage as BrowserSignInPageReply,
  BrowserSignInPageRequest,
} from "../../../../packages/protocol/src/browser-secret.ts";
import type { BrowserControl } from "./control.ts";
import type { BrowserGeometry, BrowserGeometrySnapshot } from "./geometry.ts";
import { privateCodeField } from "./secrets.ts";
import type { BrowserDocument, BrowserTargets } from "./targets.ts";

const READ_MS = 5000;

const snapshotSchema = schema.object({
  strings: schema.array(schema.string()),
  documents: schema
    .array(
      schema.object({
        nodes: schema.object({
          nodeName: schema.array(schema.number().int()),
          backendNodeId: schema.array(schema.number().int()),
          attributes: schema.array(schema.array(schema.number().int())),
        }),
      }),
    )
    .min(1),
});
const boxSchema = schema.object({
  model: schema.object({ content: schema.array(schema.number().finite()).length(8) }),
});
const hitSchema = schema.object({ backendNodeId: schema.number().int().positive() });
const ACCOUNT_NAME = /user|email|login|account|identifier/iu;

interface Candidate {
  readonly node: number;
  readonly kind: "password" | "account";
}

// The sign-in fields of a page's top document, nearest to a password first. Values are never read
// out of the snapshot: only tags and attributes.
function candidates(raw: unknown): Candidate[] {
  const snapshot = snapshotSchema.parse(raw);
  const nodes = snapshot.documents[0]?.nodes;
  if (!nodes) return [];
  const text = (at: number | undefined) =>
    at === undefined || at < 0 ? "" : (snapshot.strings[at] ?? "");
  const passwords: Candidate[] = [];
  const accounts: Candidate[] = [];
  nodes.nodeName.forEach((name, position) => {
    if (text(name).toUpperCase() !== "INPUT") return;
    const pairs = nodes.attributes[position] ?? [];
    const attributes = new Map<string, string>();
    for (let at = 0; at + 1 < pairs.length; at += 2)
      attributes.set(text(pairs[at]).toLowerCase(), text(pairs[at + 1]));
    const node = nodes.backendNodeId[position];
    if (!node || attributes.has("disabled") || attributes.has("readonly")) return;
    const type = (attributes.get("type") ?? "text").toLowerCase();
    if (type === "password") passwords.push({ node, kind: "password" });
    else if (
      ["text", "email"].includes(type) &&
      !privateCodeField(attributes) &&
      (type === "email" ||
        ACCOUNT_NAME.test(
          ["autocomplete", "id", "name", "aria-label"]
            .map((key) => attributes.get(key) ?? "")
            .join(" "),
        ))
    )
      accounts.push({ node, kind: "account" });
  });
  return [...passwords, ...accounts];
}

// Read-only, for the user's own hold of the browser: the tab the active window shows, its site
// and, when asked, the sign-in field a tap on a saved login would use. It reads no field's value
// and takes no input slot, so the user's own typing never waits on it.
export class BrowserSignInPage {
  constructor(
    private readonly options: {
      readonly control: Pick<BrowserControl, "admitManual">;
      readonly targets: Pick<BrowserTargets, "command" | "check"> &
        Partial<Pick<BrowserTargets, "rememberNodes">>;
      readonly geometry: Pick<BrowserGeometry, "front" | "read">;
      readonly scale: 1 | 2;
    },
  ) {}

  async read(
    permit: unknown,
    raw: unknown,
    signal: AbortSignal,
  ): Promise<BrowserSignInPageReply | null> {
    const { fields } = BrowserSignInPageRequest.parse(raw);
    const lease = this.options.control.admitManual(permit);
    const scope = AbortSignal.any([signal, lease.signal, AbortSignal.timeout(READ_MS)]);
    try {
      const front = await this.options.geometry.front(scope);
      if (!front) return null;
      lease.check();
      const origin = httpsOrigin(front.url);
      if (!fields || !origin) return { tabId: front.tabId, origin };
      const geometry = await this.options.geometry.read(front.tabId, scope);
      lease.check();
      const field = await this.#field(geometry, scope);
      lease.check();
      return { tabId: front.tabId, origin, ...(field ? { field } : {}) };
    } finally {
      lease.finish();
    }
  }

  async #field(geometry: BrowserGeometrySnapshot, signal: AbortSignal) {
    const { document } = geometry;
    const raw = await this.options.targets.command(
      document,
      "DOMSnapshot.captureSnapshot",
      { computedStyles: [] },
      signal,
    );
    this.options.targets.check(document);
    const found = candidates(raw);
    // cdp-guard answers only for nodes browserd itself found.
    this.options.targets.rememberNodes?.(
      document,
      found.map(({ node }) => node),
    );
    for (const { node, kind } of found) {
      const at = await this.#point(document, geometry, node, signal);
      if (at) return { kind, at };
    }
    return undefined;
  }

  // Where a field shows and answers at its own centre; undefined when it is hidden or covered.
  async #point(
    document: BrowserDocument,
    geometry: BrowserGeometrySnapshot,
    node: number,
    signal: AbortSignal,
  ) {
    const box = boxSchema.safeParse(
      await this.options.targets
        .command(document, "DOM.getBoxModel", { backendNodeId: node }, signal)
        .catch(() => null),
    );
    if (!box.success) return undefined;
    const quad = box.data.model.content;
    const x = ((quad[0] ?? 0) + (quad[4] ?? 0)) / 2;
    const y = ((quad[1] ?? 0) + (quad[5] ?? 0)) / 2;
    if (x < 0 || y < 0 || x >= geometry.width || y >= geometry.height) return undefined;
    const hit = hitSchema.safeParse(
      await this.options.targets
        .command(
          document,
          "DOM.getNodeForLocation",
          {
            x: Math.round(x + geometry.scrollX),
            y: Math.round(y + geometry.scrollY),
            includeUserAgentShadowDOM: false,
            ignorePointerEventsNone: false,
          },
          signal,
        )
        .catch(() => null),
    );
    if (!hit.success || hit.data.backendNodeId !== node) return undefined;
    const { scale } = this.options;
    const at = {
      x: (geometry.content[0] + x * geometry.factor) / scale,
      y: (geometry.content[1] + y * geometry.factor) / scale,
    };
    return at.x < 1280 && at.y < 800 ? at : undefined;
  }
}

function httpsOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}
