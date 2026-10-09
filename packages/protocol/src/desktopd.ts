import { z } from "zod";
import { Injector } from "./events.ts";
import { Point, Rect } from "./geometry.ts";
import { ULID_PATTERN } from "./ids.ts";
import { Input } from "./input.ts";
import { Target } from "./target.ts";
import { boundedText } from "./text.ts";

// desktopd's HTTP API (spec, "desktopd" table). Times are the cell's CLOCK_MONOTONIC milliseconds.

export const WindowInfo = z.object({
  id: z.number().int().nonnegative(),
  pid: z.number().int().nonnegative(),
  cls: boundedText(128),
  title: boundedText(256),
  rect: Rect,
  frame: Rect,
  active: z.boolean(),
  // Menus, popups and tooltips: never managed, never active, stacked above their parent.
  overrideRedirect: z.boolean().optional(),
  transientFor: z.number().int().nonnegative().nullable().optional(),
});
export type WindowInfo = z.infer<typeof WindowInfo>;

export const InputRequest = z.object({
  input: Input,
  window: z.number().int().nonnegative().optional(),
  // A drag lets go only over the window its drop point was in when it was approved (0: none).
  dropWindow: z.number().int().nonnegative().optional(),
  injector: Injector.default("xtest"),
  holdMs: z.number().nonnegative().max(500).default(0),
});
export type InputRequest = z.infer<typeof InputRequest>;

export const InputResult = z.object({
  pressMono: z.number(),
  presses: z.array(z.number()),
  releaseMono: z.number().optional(),
  injector: Injector,
  armedMono: z.number(),
});
export type InputResult = z.infer<typeof InputResult>;
// /input answers a repeated or held key, or a drag, as NDJSON: a line per press of a repeat, or
// one once a hold's keys or a drag's button are down; then the InputResult with `done: true`, or an
// {error, status} line.
export const KeyProgress = z.object({
  presses: z.number().int().positive(),
  pressMono: z.number(),
});
export type KeyProgress = z.infer<typeof KeyProgress>;

export const ReleaseResult = z.object({
  keys: z.number().int().nonnegative(),
  buttons: z.number().int().nonnegative(),
});
export type ReleaseResult = z.infer<typeof ReleaseResult>;
// /held keeps the buttons the agent holds down between actions down for another while, and names
// those the X server still has down (1 left, 2 middle, 3 right).
export const HeldResult = z.object({
  buttons: z.array(z.number().int().min(1).max(3)),
});
export type HeldResult = z.infer<typeof HeldResult>;

export const TypePace = z.object({
  firstMs: z.number().nonnegative(),
  firstCount: z.number().int().nonnegative(),
  restMs: z.number().nonnegative(),
});
export const TypeRequest = z.object({
  text: boundedText(4000)
    .min(1)
    .refine((text) => text.isWellFormed() && !text.includes("\0")),
  masked: z.boolean(),
  pace: TypePace,
  window: z.number().int().nonnegative().optional(),
  injector: Injector.default("xtest"),
});
export type TypeRequest = z.infer<typeof TypeRequest>;
export const TypeProgress = z.object({
  count: z.number().int().positive(),
  chunk: z.string().optional(),
  pressMono: z.number(),
});
export type TypeProgress = z.infer<typeof TypeProgress>;
export const TypeResult = z.object({
  done: z.literal(true),
  count: z.number().int().nonnegative(),
  firstPressMono: z.number().nullable(),
  injector: Injector,
  armedMono: z.number(),
});
export type TypeResult = z.infer<typeof TypeResult>;

// The input settle follows. After a click, scroll, key or typing, settle also waits until the
// app that took the input has handled it (_NET_WM_PING), so a slow dialog still reaches the frame.
export const SettleVerb = z.enum(["click", "scroll", "key", "type", "launch"]);
export type SettleVerb = z.infer<typeof SettleVerb>;
export const SettleRequest = z.object({
  quietMs: z.number().positive().max(5000).default(250),
  firstMs: z.number().positive().max(10_000).default(1500),
  timeoutMs: z.number().positive().max(30_000).default(3000),
  verb: SettleVerb.optional(),
});
export type SettleRequest = z.infer<typeof SettleRequest>;
export const SettleResult = z.object({
  changed: z.array(Rect),
  lastChangeMono: z.number().nullable(),
  quiet: z.boolean(),
  noVisibleChange: z.boolean(),
});
export type SettleResult = z.infer<typeof SettleResult>;

export const LaunchApp = z.enum([
  "chromium",
  "calc",
  "writer",
  "impress",
  "terminal",
  "thunar",
  "mousepad",
  "codium",
  "gimp",
]);
export type LaunchApp = z.infer<typeof LaunchApp>;
export const LaunchRequest = z.object({
  app: LaunchApp,
  args: z.array(z.string().max(2048)).max(16).default([]),
});
export type LaunchRequest = z.infer<typeof LaunchRequest>;
export const LaunchResult = z.object({ pid: z.number().int().positive(), armedMono: z.number() });
export type LaunchResult = z.infer<typeof LaunchResult>;

export const ClockResult = z.object({ mono: z.number() });
export type ClockResult = z.infer<typeof ClockResult>;

export const ObserveResult = z.object({
  frameId: z.string().regex(ULID_PATTERN),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  image: z.string(),
  pointer: Point,
  windows: z.array(WindowInfo),
});
export type ObserveResult = z.infer<typeof ObserveResult>;

// A region of an observed frame in model pixels, read back at the screen's device resolution.
export const ZoomRequest = z.object({ frameId: z.string().regex(ULID_PATTERN), region: Rect });
export type ZoomRequest = z.infer<typeof ZoomRequest>;

// `managed`: only managed windows count, so popups over the point (a drag's own icon) are looked
// through.
export const HitTestRequest = z.object({ point: Point, managed: z.boolean().optional() });
export type HitTestRequest = z.infer<typeof HitTestRequest>;
// desktopd clips names at the source and the gateway's clipTarget cuts to the event limits before
// it appends, so the wire repeats neither limit: an over-long name is cut, never a failed call.
export const WireTarget = Target.extend({
  role: z.string().optional(),
  name: z.string().optional(),
  app: z.string().optional(),
  window: z.string().optional(),
  url: z.string().optional(),
});
export type WireTarget = z.infer<typeof WireTarget>;
// `windowFrame` is the window's frame: with the window id, the identity a lookup always has.
// `unknown` says the element lookup did not finish in time, which is not the same as no element.
export const HitTestResult = z.object({
  target: WireTarget.nullable(),
  window: z.number().int().nonnegative().nullable(),
  windowFrame: Rect.optional(),
  unknown: z.literal(true).optional(),
  ms: z.number().nonnegative(),
});
export type HitTestResult = z.infer<typeof HitTestResult>;

// By name, or a web page's element by its DevTools node as browser_read listed it, whose role and
// name must still be the ones listed.
export const FindRequest = z.object({
  name: z.string().min(1).max(256).optional(),
  node: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  role: z.string().max(64).optional(),
  app: z.string().max(128).optional(),
  // A node: the page it was listed on. Another page's node with the same number is not it.
  url: z.string().max(2048).optional(),
});
export type FindRequest = z.infer<typeof FindRequest>;

// What an element shows besides its name: a field's value, a box's tick, a closed or open list.
export const ElementState = z.object({
  value: z.string().max(200).optional(),
  checked: z.enum(["true", "false", "mixed"]).optional(),
  disabled: z.literal(true).optional(),
  expanded: z.boolean().optional(),
});
export type ElementState = z.infer<typeof ElementState>;

// An accessibility tree's `checked` property as an element's state.
export function checkedOf(value: unknown): ElementState["checked"] {
  if (value === true || value === "true") return "true";
  if (value === false || value === "false") return "false";
  return value === "mixed" ? "mixed" : undefined;
}

// The controls whose names contain `text` in every window, top first; or with `page`, the
// interactive elements of the page in the front Chromium window, each with its DevTools node.
export const ElementsRequest = z.object({
  text: z.string().min(1).max(200).optional(),
  role: z.string().min(1).max(64).optional(),
  page: z.boolean().optional(),
  limit: z.number().int().min(1).max(300).default(30),
});
export type ElementsRequest = z.input<typeof ElementsRequest>;
export const WireElement = WireTarget.extend({
  node: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  state: ElementState.optional(),
});
export type WireElement = z.infer<typeof WireElement>;
export const ElementsResult = z.object({
  elements: z.array(WireElement).max(300),
  // The page's address, with `page`.
  url: z.string().optional(),
  truncated: z.boolean(),
});
export type ElementsResult = z.infer<typeof ElementsResult>;
