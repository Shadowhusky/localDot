import { types } from "node:util";
import {
  BrowserReadRequest,
  type BrowserReadResult,
  type HitTestResult,
  type ObserveResult,
  type Target,
  ulid,
} from "@localdot/protocol";
import { z as schema } from "zod";
import type { BrowserCapture } from "./capture.ts";
import type { BrowserActionLease, BrowserControl } from "./control.ts";
import type { BrowserGeometry, BrowserGeometrySnapshot } from "./geometry.ts";
import { captureBrowserRequest } from "./input.ts";
import type { BrowserNative } from "./native.ts";
import { type BrowserProjection, projectBrowser } from "./perception.ts";
import type { BrowserSecrets } from "./secrets.ts";
import type { BrowserDocument, BrowserTargets } from "./targets.ts";

export const BROWSER_OBSERVATION_TIMEOUT_MS = 15000;
const frameSchema = schema.object({
  frameTree: schema.object({ frame: schema.object({ id: schema.string().min(1).max(128) }) }),
});
const lookupSchema = schema.discriminatedUnion("kind", [
  schema.strictObject({ kind: schema.literal("focused") }),
  schema.strictObject({
    kind: schema.literal("hitTest"),
    point: schema.strictObject({
      x: schema.number().finite().min(0).lt(1280),
      y: schema.number().finite().min(0).lt(800),
    }),
  }),
  schema.strictObject({
    kind: schema.literal("find"),
    name: schema.string().min(1).max(256),
    role: schema.string().max(64).optional(),
    app: schema.string().max(128).optional(),
  }),
]);
const hitSchema = schema.object({
  backendNodeId: schema.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  frameId: schema.string().min(1).max(128),
});

export class BrowserObservationError extends Error {
  constructor(
    readonly reason: "closed" | "busy" | "aborted" | "request" | "unavailable" | "stale" | "secret",
  ) {
    super(`Browser observation refused: ${reason}`);
  }
}

export interface BrowserObservationOptions {
  readonly control: Pick<BrowserControl, "admit">;
  readonly targets: Pick<BrowserTargets, "check" | "command">;
  readonly geometry: Pick<BrowserGeometry, "read"> & Partial<Pick<BrowserGeometry, "point">>;
  readonly secrets: Pick<BrowserSecrets, "secretFocused">;
  readonly native: Pick<BrowserNative, "command">;
  readonly capture: Pick<BrowserCapture, "masked">;
  readonly scale: 1 | 2;
}

export interface BrowserObservationResult {
  readonly frame: ObserveResult;
  readonly targets: readonly Target[];
}

function permitData(raw: unknown, depth = 0): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || types.isProxy(raw) || depth > 1)
    throw new BrowserObservationError("request");
  const prototype = Object.getPrototypeOf(raw);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(raw).length
  )
    throw new BrowserObservationError("request");
  const names = Object.getOwnPropertyNames(raw);
  if (names.length > 6) throw new BrowserObservationError("request");
  const result: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, name);
    if (
      name.length > 32 ||
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    )
      throw new BrowserObservationError("request");
    const value: unknown = descriptor.value;
    if (
      (typeof value === "string" && value.length <= 128) ||
      (typeof value === "number" && Number.isSafeInteger(value))
    )
      result[name] = value;
    else result[name] = permitData(value, depth + 1);
  }
  return result;
}

function sameGeometry(first: BrowserGeometrySnapshot, second: BrowserGeometrySnapshot): boolean {
  return (
    first.document.tabId === second.document.tabId &&
    first.document.revision === second.document.revision &&
    first.document.frame === second.document.frame &&
    first.content.every((value, position) => value === second.content[position]) &&
    first.width === second.width &&
    first.height === second.height &&
    first.factor === second.factor &&
    first.scrollX === second.scrollX &&
    first.scrollY === second.scrollY &&
    first.focus === second.focus
  );
}

export class BrowserObservation {
  readonly #options: Readonly<BrowserObservationOptions>;
  readonly #lifetime = new AbortController();
  #active?: Promise<void>;

  constructor(options: BrowserObservationOptions) {
    if (options.scale !== 1 && options.scale !== 2) throw new BrowserObservationError("request");
    this.#options = Object.freeze({ ...options });
  }

  close(): Promise<void> {
    this.#lifetime.abort();
    return this.#active ?? Promise.resolve();
  }

  async observe(
    rawPermit: unknown,
    tabId: string,
    signal: AbortSignal,
  ): Promise<BrowserObservationResult> {
    const result = await this.#perform(rawPermit, tabId, signal);
    if (!("frame" in result)) throw new BrowserObservationError("unavailable");
    return result;
  }

  async lookup(
    rawPermit: unknown,
    tabId: string,
    raw: unknown,
    signal: AbortSignal,
  ): Promise<HitTestResult> {
    let query: schema.infer<typeof lookupSchema>;
    try {
      query = lookupSchema.parse(captureBrowserRequest(raw));
    } catch {
      throw new BrowserObservationError("request");
    }
    const result = await this.#perform(rawPermit, tabId, signal, query);
    if (!("target" in result)) throw new BrowserObservationError("unavailable");
    return result;
  }

  async read(
    rawPermit: unknown,
    tabId: string,
    raw: unknown,
    signal: AbortSignal,
  ): Promise<BrowserReadResult> {
    let request: schema.output<typeof BrowserReadRequest>;
    try {
      request = BrowserReadRequest.strict().parse(captureBrowserRequest(raw));
    } catch {
      throw new BrowserObservationError("request");
    }
    const result = await this.#perform(rawPermit, tabId, signal, { kind: "read", ...request });
    if (!("text" in result)) throw new BrowserObservationError("unavailable");
    return result;
  }

  async #perform(
    rawPermit: unknown,
    tabId: string,
    signal: AbortSignal,
    query?: schema.infer<typeof lookupSchema> | { kind: "read"; maxChars: number },
  ): Promise<BrowserObservationResult | HitTestResult | BrowserReadResult> {
    const started = performance.now();
    if (this.#lifetime.signal.aborted) throw new BrowserObservationError("closed");
    if (this.#active) throw new BrowserObservationError("busy");
    const completion = Promise.withResolvers<void>();
    this.#active = completion.promise;
    let lease: BrowserActionLease | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let operationSignal: AbortSignal | undefined;
    try {
      if (signal.aborted) throw new BrowserObservationError("aborted");
      if (typeof tabId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(tabId))
        throw new BrowserObservationError("request");
      const permit = permitData(rawPermit);
      lease = this.#options.control.admit(permit);
      const expiry = new AbortController();
      deadline = setTimeout(() => expiry.abort(), BROWSER_OBSERVATION_TIMEOUT_MS);
      const combined = AbortSignal.any([
        signal,
        lease.signal,
        this.#lifetime.signal,
        expiry.signal,
      ]);
      operationSignal = combined;
      const current = lease;
      const check = (document?: BrowserDocument) => {
        if (combined.aborted) throw new BrowserObservationError("aborted");
        current.check();
        if (document) {
          if (document.tabId !== tabId || document.frame)
            throw new BrowserObservationError("stale");
          this.#options.targets.check(document);
        }
      };
      const read = async (): Promise<{
        geometry: BrowserGeometrySnapshot;
        projection: BrowserProjection;
        rootFrame: string;
      }> => {
        check();
        const geometry = await this.#options.geometry.read(tabId, combined);
        check(geometry.document);
        if (geometry.focus !== "page") throw new BrowserObservationError("unavailable");
        if (await this.#options.secrets.secretFocused(tabId, combined))
          throw new BrowserObservationError("secret");
        check(geometry.document);
        const rawFrame = await this.#options.targets.command(
          geometry.document,
          "Page.getFrameTree",
          {},
          combined,
        );
        check(geometry.document);
        const frame = frameSchema.parse(rawFrame).frameTree.frame.id;
        const snapshot = await this.#options.targets.command(
          geometry.document,
          "DOMSnapshot.captureSnapshot",
          { computedStyles: [] },
          combined,
        );
        check(geometry.document);
        const accessibility = await this.#options.targets.command(
          geometry.document,
          "Accessibility.getFullAXTree",
          {},
          combined,
        );
        check(geometry.document);
        const projection = projectBrowser(
          snapshot,
          accessibility,
          frame,
          geometry,
          this.#options.scale,
          query?.kind === "read" ? query.maxChars : undefined,
        );
        check(geometry.document);
        return { geometry, projection, rootFrame: frame };
      };
      const before = await read();
      check(before.geometry.document);
      if (query?.kind === "read") {
        const after = await read();
        check(before.geometry.document);
        check(after.geometry.document);
        if (
          !before.projection.page ||
          !after.projection.page ||
          !sameGeometry(before.geometry, after.geometry) ||
          before.projection.signature !== after.projection.signature ||
          JSON.stringify(before.projection.page) !== JSON.stringify(after.projection.page)
        )
          throw new BrowserObservationError("stale");
        return after.projection.page;
      }
      if (query) {
        const pick = async (snapshot: Awaited<ReturnType<typeof read>>) => {
          const projection = snapshot.projection;
          if (query.kind === "focused") return { target: projection.focused };
          if (query.kind === "find") {
            const matches = projection.targets.filter(
              (target) =>
                target.name?.toLocaleLowerCase() === query.name.toLocaleLowerCase() &&
                (!query.role || target.role === query.role) &&
                (!query.app || target.app === query.app),
            );
            // Ambiguous names cannot silently authorize a different element.
            return { target: matches.length === 1 ? (matches[0] ?? null) : null };
          }
          const geometry = snapshot.geometry;
          const point = this.#options.geometry.point?.(
            geometry,
            (query.point.x * this.#options.scale - geometry.content[0]) / geometry.factor,
            (query.point.y * this.#options.scale - geometry.content[1]) / geometry.factor,
            combined,
          );
          if (!point) throw new BrowserObservationError("unavailable");
          check(geometry.document);
          const hit = hitSchema.parse(
            await this.#options.targets.command(
              geometry.document,
              "DOM.getNodeForLocation",
              {
                ...point.document,
                includeUserAgentShadowDOM: false,
                ignorePointerEventsNone: false,
              },
              combined,
            ),
          );
          check(geometry.document);
          if (hit.frameId !== snapshot.rootFrame) throw new BrowserObservationError("stale");
          return { target: projection.targetForNode(hit.backendNodeId), node: hit.backendNodeId };
        };
        const first = await pick(before);
        const after = await read();
        check(before.geometry.document);
        check(after.geometry.document);
        const second = await pick(after);
        check(before.geometry.document);
        check(after.geometry.document);
        if (
          !sameGeometry(before.geometry, after.geometry) ||
          before.projection.signature !== after.projection.signature ||
          JSON.stringify(first) !== JSON.stringify(second)
        )
          throw new BrowserObservationError("stale");
        return {
          target: second.target,
          window: null,
          ms: Math.max(0, performance.now() - started),
        };
      }
      const image = await this.#options.capture.masked(before.projection.mask, combined);
      check(before.geometry.document);
      const pointer = await this.#options.native.command("pointer", {}, combined);
      check(before.geometry.document);
      const after = await read();
      check(before.geometry.document);
      check(after.geometry.document);
      if (
        !sameGeometry(before.geometry, after.geometry) ||
        before.projection.signature !== after.projection.signature
      )
        throw new BrowserObservationError("stale");
      if (
        !Number.isFinite(pointer.x) ||
        !Number.isFinite(pointer.y) ||
        pointer.x < 0 ||
        pointer.y < 0 ||
        pointer.x >= 1280 * this.#options.scale ||
        pointer.y >= 800 * this.#options.scale
      )
        throw new BrowserObservationError("unavailable");
      const frame: ObserveResult = {
        frameId: ulid(),
        width: 1280,
        height: 800,
        image: image.toString("base64"),
        pointer: { x: pointer.x / this.#options.scale, y: pointer.y / this.#options.scale },
        windows: [],
      };
      check(after.geometry.document);
      return Object.freeze({ frame, targets: after.projection.targets });
    } catch (error) {
      if (operationSignal?.aborted || signal.aborted || this.#lifetime.signal.aborted)
        throw new BrowserObservationError("aborted");
      if (error instanceof BrowserObservationError) throw error;
      throw new BrowserObservationError("unavailable");
    } finally {
      clearTimeout(deadline);
      try {
        lease?.finish();
      } finally {
        this.#active = undefined;
        completion.resolve();
      }
    }
  }
}
