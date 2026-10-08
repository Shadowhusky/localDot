import { setTimeout as sleep } from "node:timers/promises";
import { types } from "node:util";
import {
  type InputResult,
  ManualInput,
  SettleRequest,
  type TypeProgress,
  type TypeResult,
} from "@localdot/protocol";
import { z as schema } from "zod";
import type { BrowserManualReply } from "../../../../packages/protocol/src/browser-control.ts";
import { keyName } from "../../../desktop/desktopd/src/x/keys.ts";
import type { BrowserActionLease, BrowserControl } from "./control.ts";
import type { BrowserGeometry, BrowserGeometrySnapshot, BrowserPoint } from "./geometry.ts";
import type { BrowserNative } from "./native.ts";
import { type NativeEvent, nativeRequest } from "./native-schema.ts";
import type { BrowserSecrets } from "./secrets.ts";
import type { BrowserDocument, BrowserTargets } from "./targets.ts";

export const BROWSER_INPUT_TIMEOUT_MS = 120_000;
export const BROWSER_INPUT_PRESS_MS = 150;

const screenPoint = schema.strictObject({
  x: schema.number().finite().min(0).lt(1280),
  y: schema.number().finite().min(0).lt(800),
});
const key = schema.string().min(1).max(16);
const pointerInput = schema.discriminatedUnion("kind", [
  schema.strictObject({
    kind: schema.literal("click"),
    at: screenPoint,
    button: schema.enum(["left", "middle", "right"]),
    count: schema.number().int().min(1).max(3),
    mods: schema.array(key).max(2).default([]),
  }),
  schema.strictObject({ kind: schema.literal("move"), to: screenPoint }),
  schema.strictObject({
    kind: schema.literal("scroll"),
    at: screenPoint,
    dx: schema.number().int().min(-30).max(30),
    dy: schema.number().int().min(-30).max(30),
  }),
  schema.strictObject({ kind: schema.literal("key"), combo: schema.array(key).min(1).max(3) }),
]);
const inputSchema = schema.strictObject({
  input: pointerInput,
  injector: schema.literal("xtest").default("xtest"),
  holdMs: schema.number().finite().nonnegative().max(500).default(0),
});
const typeSchema = schema.strictObject({
  text: schema
    .string()
    .min(1)
    .max(4000)
    .refine((text) => text.isWellFormed()),
  masked: schema.boolean(),
  injector: schema.literal("xtest").default("xtest"),
  pace: schema.strictObject({
    firstCount: schema.number().int().min(0).max(4000),
    firstMs: schema.number().finite().min(0).max(1000),
    restMs: schema.number().finite().min(0).max(1000),
  }),
});
const frameSchema = schema.object({
  frameTree: schema.object({ frame: schema.object({ id: schema.string().min(1).max(128) }) }),
});
const hitSchema = schema.object({
  backendNodeId: schema.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  frameId: schema.string().min(1).max(128),
});

export class BrowserInputError extends Error {
  constructor(
    readonly reason:
      | "request"
      | "busy"
      | "closed"
      | "aborted"
      | "focus"
      | "secret"
      | "target"
      | "delivery"
      | "unavailable",
  ) {
    super(`Browser input refused: ${reason}`);
  }
}

export interface BrowserInputOptions {
  readonly control: Pick<BrowserControl, "admit"> & Partial<Pick<BrowserControl, "admitManual">>;
  readonly targets: Pick<BrowserTargets, "check" | "command">;
  readonly geometry: Pick<BrowserGeometry, "read" | "point">;
  readonly secrets: Pick<BrowserSecrets, "inspect" | "secretFocused">;
  readonly native: Pick<BrowserNative, "command" | "onEvent">;
  readonly scale: 1 | 2;
  onFatal(reason: BrowserInputError): void;
}

interface Scope {
  readonly signal: AbortSignal;
  check(document?: BrowserDocument): void;
}

function capture(raw: unknown): unknown {
  let remaining = 96;
  const visit = (value: unknown, depth: number): unknown => {
    remaining -= 1;
    if (remaining < 0 || depth > 5) throw new BrowserInputError("request");
    if (typeof value === "string" && value.length <= 4000) return value;
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
      return value;
    if (!value || typeof value !== "object" || types.isProxy(value))
      throw new BrowserInputError("request");
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (
      array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
    )
      throw new BrowserInputError("request");
    if (Object.getOwnPropertySymbols(value).length) throw new BrowserInputError("request");
    const names = Object.getOwnPropertyNames(value);
    if (names.length > 12) throw new BrowserInputError("request");
    const result: Record<string, unknown> = Object.create(null);
    for (const name of names) {
      if (array && name === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, "value") ||
        !descriptor.enumerable ||
        name.length > 32
      )
        throw new BrowserInputError("request");
      result[name] = visit(descriptor.value, depth + 1);
    }
    if (!array) return result;
    if (names.length !== value.length + 1 || value.length > 3)
      throw new BrowserInputError("request");
    return Array.from({ length: value.length }, (_unused, position) => {
      if (!Object.hasOwn(result, String(position))) throw new BrowserInputError("request");
      return result[String(position)];
    });
  };
  return visit(raw, 0);
}

export { capture as captureBrowserRequest };

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

export class BrowserInput {
  readonly #options: Readonly<BrowserInputOptions>;
  readonly #lifetime = new AbortController();
  #active?: Promise<void>;

  constructor(options: BrowserInputOptions) {
    if (![1, 2].includes(options.scale)) throw new BrowserInputError("request");
    this.#options = Object.freeze({ ...options });
  }

  close(): Promise<void> {
    this.#lifetime.abort();
    return this.#active ?? Promise.resolve();
  }

  timing(permit: unknown, tabId: string, raw: unknown, signal: AbortSignal) {
    return this.#run(
      permit,
      tabId,
      raw,
      signal,
      (value) =>
        schema
          .discriminatedUnion("kind", [
            schema.strictObject({ kind: schema.literal("clock") }),
            schema.strictObject({
              kind: schema.literal("settle"),
              request: SettleRequest.strict(),
            }),
          ])
          .parse(value),
      async (request, scope) => {
        // Timing also carries the current physical grant; it must not outlive takeover.
        const geometry = await this.#geometry(tabId, scope);
        if (request.kind === "clock") {
          const result = await this.#options.native.command("ping", {}, scope.signal);
          scope.check(geometry.document);
          return result;
        }
        const result = await this.#options.native.command("settle", request.request, scope.signal);
        scope.check(geometry.document);
        return {
          changed: result.changed.map(([x, y, w, h]) => ({ x, y, w, h })),
          lastChangeMono: result.lastChange,
          quiet: result.quiet,
          noVisibleChange: result.noVisibleChange,
        };
      },
    );
  }

  async #run<Request, Result>(
    permit: unknown,
    tabId: string,
    raw: unknown,
    signal: AbortSignal,
    prepare: (value: unknown) => Request,
    perform: (request: Request, scope: Scope) => Promise<Result>,
    manual = false,
  ): Promise<Result> {
    if (this.#lifetime.signal.aborted) throw new BrowserInputError("closed");
    if (this.#active) throw new BrowserInputError("busy");
    const completion = Promise.withResolvers<void>();
    this.#active = completion.promise;
    let lease: BrowserActionLease | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let combined: AbortSignal | undefined;
    try {
      if (signal.aborted) throw new BrowserInputError("aborted");
      if (!manual && (typeof tabId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(tabId)))
        throw new BrowserInputError("request");
      const request = prepare(capture(raw));
      const capturedPermit = capture(permit);
      if (signal.aborted || this.#lifetime.signal.aborted) throw new BrowserInputError("aborted");
      lease = manual
        ? this.#options.control.admitManual?.(capturedPermit)
        : this.#options.control.admit(capturedPermit);
      if (!lease) throw new BrowserInputError("unavailable");
      const expiry = new AbortController();
      deadline = setTimeout(() => expiry.abort(), manual ? 30_000 : BROWSER_INPUT_TIMEOUT_MS);
      combined = AbortSignal.any([signal, lease.signal, this.#lifetime.signal, expiry.signal]);
      const current = lease;
      const operationSignal = combined;
      const scope: Scope = {
        signal: operationSignal,
        check: (document) => {
          if (operationSignal.aborted) throw new BrowserInputError("aborted");
          current.check();
          if (document) {
            if (document.tabId !== tabId || document.frame) throw new BrowserInputError("target");
            this.#options.targets.check(document);
          }
        },
      };
      scope.check();
      const result = await perform(request, scope);
      scope.check();
      return result;
    } catch (error) {
      if (error instanceof BrowserInputError && error.reason === "delivery") throw error;
      if (combined?.aborted || signal.aborted) throw new BrowserInputError("aborted");
      if (error instanceof BrowserInputError) throw error;
      throw new BrowserInputError("unavailable");
    } finally {
      clearTimeout(deadline);
      lease?.finish();
      this.#active = undefined;
      completion.resolve();
    }
  }

  // User-only native input has no DOM read, screenshot, text echo or progress stream.
  // A completed user-control receipt authorizes the whole owned browser display,
  // including secret fields. Agent methods retain their separate page/secret checks.
  manual(permit: unknown, raw: unknown, signal: AbortSignal): Promise<BrowserManualReply> {
    const scale = this.#options.scale;
    const point = (at: { x: number; y: number }) => ({ x: Math.floor(at.x), y: Math.floor(at.y) });
    const button = { left: 1, middle: 2, right: 3 };
    const scrollParts = (input: { at: { x: number; y: number }; dx: number; dy: number }) => {
      const dx = Math.max(-30, Math.min(30, input.dx));
      const dy = Math.max(-30, Math.min(30, input.dy));
      return [
        { ...point(input.at), dx, dy },
        { ...point(input.at), dx: input.dx - dx, dy: input.dy - dy },
      ].filter((part) => part.dx !== 0 || part.dy !== 0);
    };
    return this.#run(
      permit,
      "",
      raw,
      signal,
      (raw) => {
        const input = ManualInput.parse(raw);
        let valid: unknown;
        if (input.kind === "text") {
          valid = [...input.text].every((ch) => nativeRequest("char", { ch }, scale));
        } else if (input.kind === "key") {
          valid = nativeRequest("userKeys", { combo: input.combo.map(keyName) }, scale);
        } else if (input.kind === "click") {
          valid = nativeRequest(
            "userClick",
            {
              ...point(input.at),
              button: button[input.button],
              count: input.count,
              holdMs: 0,
              mods: (input.mods ?? []).map(keyName),
            },
            scale,
          );
        } else {
          valid = scrollParts(input).every((part) => nativeRequest("scroll", part, scale));
        }
        if (!valid) throw new BrowserInputError("request");
        return input;
      },
      async (input, scope): Promise<BrowserManualReply> => {
        const { mono: armedMono } = await this.#options.native.command("arm", {}, scope.signal);
        scope.check();
        if (input.kind === "text") {
          let count = 0,
            firstPressMono: number | null = null;
          for (const ch of input.text) {
            scope.check();
            const receipt = await this.#press(
              scope,
              armedMono,
              () => this.#options.native.command("char", { ch }, scope.signal),
              (event, reply) => event.kind === "key" && event.detail === reply.keycode,
              1,
            );
            firstPressMono ??= receipt.presses[0] as number;
            count++;
          }
          return {
            kind: "text",
            receipt: { done: true, count, firstPressMono, armedMono, injector: "xtest" },
          };
        }
        if (input.kind === "scroll") {
          const presses: number[] = [];
          let releaseMono: number | undefined;
          for (const part of scrollParts(input)) {
            scope.check();
            const receipt = await this.#press(
              scope,
              armedMono,
              () => this.#options.native.command("scroll", part, scope.signal),
              (event) => event.kind === "button" && event.detail >= 4 && event.detail <= 7,
              Math.abs(part.dx) + Math.abs(part.dy),
            );
            presses.push(...receipt.presses);
            releaseMono = receipt.releaseMono;
          }
          return {
            kind: "input",
            receipt: {
              armedMono,
              pressMono: presses[0] as number,
              presses,
              injector: "xtest",
              ...(releaseMono === undefined ? {} : { releaseMono }),
            },
          };
        }
        const receipt =
          input.kind === "key"
            ? await this.#press(
                scope,
                armedMono,
                () =>
                  this.#options.native.command(
                    "userKeys",
                    { combo: input.combo.map(keyName) },
                    scope.signal,
                  ),
                (event, reply) => event.kind === "key" && event.detail === reply.keycodes.at(-1),
                1,
              )
            : await this.#press(
                scope,
                armedMono,
                () =>
                  this.#options.native.command(
                    "userClick",
                    {
                      ...point(input.at),
                      button: button[input.button],
                      count: input.count,
                      holdMs: 0,
                      mods: (input.mods ?? []).map(keyName) as (
                        | "Control_L"
                        | "Shift_L"
                        | "Alt_L"
                        | "Super_L"
                      )[],
                    },
                    scope.signal,
                  ),
                (event) => event.kind === "button" && event.detail === button[input.button],
                input.count,
              );
        return {
          kind: "input",
          receipt: {
            armedMono,
            pressMono: receipt.presses[0] as number,
            presses: [...receipt.presses],
            injector: "xtest",
            ...(receipt.releaseMono === undefined ? {} : { releaseMono: receipt.releaseMono }),
          },
        };
      },
      true,
    );
  }

  async #geometry(tabId: string, scope: Scope): Promise<BrowserGeometrySnapshot> {
    scope.check();
    const snapshot = await this.#options.geometry.read(tabId, scope.signal);
    scope.check(snapshot.document);
    if (snapshot.focus === "unknown") throw new BrowserInputError("focus");
    return snapshot;
  }

  async #keyboard(tabId: string, scope: Scope): Promise<BrowserDocument> {
    const first = await this.#geometry(tabId, scope);
    if (first.focus !== "page") throw new BrowserInputError("focus");
    const secret = await this.#options.secrets.secretFocused(tabId, scope.signal);
    scope.check(first.document);
    if (secret) throw new BrowserInputError("secret");
    const second = await this.#geometry(tabId, scope);
    if (second.focus !== "page" || !sameGeometry(first, second))
      throw new BrowserInputError("focus");
    scope.check(first.document);
    return second.document;
  }

  async #pointer(
    tabId: string,
    at: Readonly<{ x: number; y: number }>,
    scope: Scope,
  ): Promise<{ point: BrowserPoint; document: BrowserDocument }> {
    const first = await this.#geometry(tabId, scope);
    const point = this.#options.geometry.point(
      first,
      (at.x * this.#options.scale - first.content[0]) / first.factor,
      (at.y * this.#options.scale - first.content[1]) / first.factor,
      scope.signal,
    );
    scope.check(first.document);
    const frame = frameSchema.parse(
      await this.#options.targets.command(first.document, "Page.getFrameTree", {}, scope.signal),
    );
    scope.check(first.document);
    const secret = await this.#options.secrets.inspect(first.document, scope.signal);
    scope.check(first.document);
    const hit = hitSchema.parse(
      await this.#options.targets.command(
        first.document,
        "DOM.getNodeForLocation",
        { ...point.document, includeUserAgentShadowDOM: false, ignorePointerEventsNone: false },
        scope.signal,
      ),
    );
    scope.check(first.document);
    if (hit.frameId !== frame.frameTree.frame.id) throw new BrowserInputError("target");
    if (secret.nodeIds.includes(hit.backendNodeId)) throw new BrowserInputError("secret");
    const second = await this.#geometry(tabId, scope);
    if (!sameGeometry(first, second)) throw new BrowserInputError("target");
    const finalHit = hitSchema.parse(
      await this.#options.targets.command(
        second.document,
        "DOM.getNodeForLocation",
        { ...point.document, includeUserAgentShadowDOM: false, ignorePointerEventsNone: false },
        scope.signal,
      ),
    );
    scope.check(first.document);
    scope.check(second.document);
    if (hit.backendNodeId !== finalHit.backendNodeId || hit.frameId !== finalHit.frameId)
      throw new BrowserInputError("target");
    return { point, document: second.document };
  }

  #fatal(): never {
    const error = new BrowserInputError("delivery");
    this.#lifetime.abort();
    try {
      this.#options.onFatal(error);
    } catch {}
    throw error;
  }

  async #progress(
    scope: Scope,
    progress: TypeProgress,
    onProgress: (progress: TypeProgress) => void | Promise<void>,
  ): Promise<void> {
    scope.check();
    const cancellation = Promise.withResolvers<never>();
    void cancellation.promise.catch(() => {});
    const cancel = () => cancellation.reject(new BrowserInputError("aborted"));
    scope.signal.addEventListener("abort", cancel, { once: true });
    try {
      scope.check();
      await Promise.race([Promise.resolve(onProgress(progress)), cancellation.promise]);
      scope.check();
    } finally {
      scope.signal.removeEventListener("abort", cancel);
    }
  }

  async #press<Reply>(
    scope: Scope,
    armedMono: number,
    act: () => Promise<Reply>,
    match: (event: Readonly<NativeEvent>, reply: Reply) => boolean,
    count: number,
  ): Promise<{ presses: readonly number[]; releaseMono?: number }> {
    const events: Readonly<NativeEvent>[] = [];
    let changed = Promise.withResolvers<void>();
    let overflow = false;
    const unsubscribe = this.#options.native.onEvent((event) => {
      if (events.length >= 256) overflow = true;
      else if (event.mono >= armedMono) events.push(event);
      changed.resolve();
    });
    const waiting = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      scope.check();
      const reply = await act();
      scope.check();
      timer = setTimeout(() => waiting.abort(), BROWSER_INPUT_PRESS_MS);
      const deadline = Date.now() + BROWSER_INPUT_PRESS_MS;
      while (true) {
        scope.check();
        if (overflow) this.#fatal();
        const presses = events.filter((event) => event.ev === "press" && match(event, reply));
        if (presses.length >= count) {
          const first = presses[0];
          if (!first) this.#fatal();
          const release = events.find(
            (event) => event.ev === "release" && event.mono >= first.mono && match(event, reply),
          );
          return {
            presses: Object.freeze(presses.slice(0, count).map((event) => event.mono)),
            ...(release ? { releaseMono: release.mono } : {}),
          };
        }
        if (Date.now() >= deadline || waiting.signal.aborted) this.#fatal();
        changed = Promise.withResolvers<void>();
        const wake = AbortSignal.any([scope.signal, waiting.signal]);
        const expired = sleep(BROWSER_INPUT_PRESS_MS, undefined, { signal: wake }).catch(() => {});
        await Promise.race([changed.promise, expired]);
      }
    } finally {
      clearTimeout(timer);
      waiting.abort();
      unsubscribe();
    }
  }

  inject(permit: unknown, tabId: string, raw: unknown, signal: AbortSignal): Promise<InputResult> {
    return this.#run(
      permit,
      tabId,
      raw,
      signal,
      (value) => {
        const parsed = inputSchema.safeParse(value);
        if (!parsed.success) throw new BrowserInputError("request");
        const request = parsed.data;
        if (request.input.kind === "key") {
          request.input.combo = request.input.combo.map(keyName);
          if (!nativeRequest("keys", { combo: request.input.combo }, this.#options.scale))
            throw new BrowserInputError("request");
        }
        if (request.input.kind === "click") {
          request.input.mods = request.input.mods.map(keyName);
          if (
            !nativeRequest(
              "click",
              {
                x: 0,
                y: 0,
                button: 1,
                count: request.input.count,
                holdMs: request.holdMs,
                mods: request.input.mods,
              },
              this.#options.scale,
            )
          )
            throw new BrowserInputError("request");
        }
        if (request.input.kind === "scroll" && request.input.dx === 0 && request.input.dy === 0)
          throw new BrowserInputError("request");
        return request;
      },
      async (request, scope) => {
        const { mono: armedMono } = await this.#options.native.command("arm", {}, scope.signal);
        scope.check();
        const input = request.input;
        if (input.kind === "key") {
          const document = await this.#keyboard(tabId, scope);
          scope.check(document);
          const receipt = await this.#press(
            scope,
            armedMono,
            () => this.#options.native.command("keys", { combo: input.combo }, scope.signal),
            (event, reply) => event.kind === "key" && event.detail === reply.keycodes.at(-1),
            1,
          );
          return {
            armedMono,
            pressMono: receipt.presses[0] as number,
            presses: [...receipt.presses],
            injector: "xtest",
            ...(receipt.releaseMono === undefined ? {} : { releaseMono: receipt.releaseMono }),
          };
        }
        const mapped = await this.#pointer(
          tabId,
          input.kind === "move" ? input.to : input.at,
          scope,
        );
        scope.check(mapped.document);
        if (input.kind === "move") {
          const receipt = await this.#options.native.command(
            "move",
            { ...mapped.point.native },
            scope.signal,
          );
          scope.check();
          return { armedMono, pressMono: receipt.mono, presses: [], injector: "xtest" };
        }
        if (input.kind === "click") {
          const button = { left: 1, middle: 2, right: 3 }[input.button];
          const receipt = await this.#press(
            scope,
            armedMono,
            () =>
              this.#options.native.command(
                "click",
                {
                  ...mapped.point.native,
                  button,
                  count: input.count,
                  holdMs: request.holdMs,
                  mods: input.mods as ("Control_L" | "Shift_L")[],
                },
                scope.signal,
              ),
            (event) => event.kind === "button" && event.detail === button,
            input.count,
          );
          return {
            armedMono,
            pressMono: receipt.presses[0] as number,
            presses: [...receipt.presses],
            injector: "xtest",
            ...(receipt.releaseMono === undefined ? {} : { releaseMono: receipt.releaseMono }),
          };
        }
        const notches = Math.abs(input.dx) + Math.abs(input.dy);
        const receipt = await this.#press(
          scope,
          armedMono,
          () =>
            this.#options.native.command(
              "scroll",
              { ...mapped.point.native, dx: input.dx, dy: input.dy },
              scope.signal,
            ),
          (event) => event.kind === "button" && event.detail >= 4 && event.detail <= 7,
          notches,
        );
        return {
          armedMono,
          pressMono: receipt.presses[0] as number,
          presses: [...receipt.presses],
          injector: "xtest",
        };
      },
    );
  }

  type(
    permit: unknown,
    tabId: string,
    raw: unknown,
    signal: AbortSignal,
    onProgress: (progress: TypeProgress) => void | Promise<void>,
  ): Promise<TypeResult> {
    return this.#run(
      permit,
      tabId,
      raw,
      signal,
      (value) => {
        const parsed = typeSchema.safeParse(value);
        if (!parsed.success) throw new BrowserInputError("request");
        const request = parsed.data;
        const characters = [...request.text];
        if (characters.some((ch) => !nativeRequest("char", { ch }, this.#options.scale)))
          throw new BrowserInputError("request");
        const duration = characters.reduce(
          (total, _character, position) =>
            total +
            (position === 0
              ? 0
              : position < request.pace.firstCount
                ? request.pace.firstMs
                : request.pace.restMs),
          0,
        );
        if (duration >= BROWSER_INPUT_TIMEOUT_MS) throw new BrowserInputError("request");
        return request;
      },
      async (request, scope) => {
        const { mono: armedMono } = await this.#options.native.command("arm", {}, scope.signal);
        scope.check();
        const characters = [...request.text];
        let firstPressMono: number | null = null;
        let count = 0;
        for (const character of characters) {
          const delay =
            count < request.pace.firstCount ? request.pace.firstMs : request.pace.restMs;
          if (count > 0 && delay > 0) await sleep(delay, undefined, { signal: scope.signal });
          scope.check();
          const document = await this.#keyboard(tabId, scope);
          scope.check(document);
          const receipt = await this.#press(
            scope,
            armedMono,
            () => this.#options.native.command("char", { ch: character }, scope.signal),
            (event, reply) => event.kind === "key" && event.detail === reply.keycode,
            1,
          );
          const pressMono = receipt.presses[0] as number;
          firstPressMono ??= pressMono;
          count += 1;
          scope.check();
          if (
            count <= request.pace.firstCount ||
            (count - request.pace.firstCount) % 8 === 0 ||
            count === characters.length
          ) {
            await this.#progress(scope, Object.freeze({ count, pressMono }), onProgress);
          }
        }
        return { done: true, count, firstPressMono, armedMono, injector: "xtest" };
      },
    );
  }
}
