import { types } from "node:util";
import { z as schema } from "zod";

const empty = schema.strictObject({});
const coordinate = schema.number().int().min(-8192).max(8192);
const dimension = schema.number().int().nonnegative().max(8192);
const mono = schema.number().finite().nonnegative();
const keycode = schema.number().int().min(8).max(255);
const windowId = schema.number().int().positive().max(0xffffffff);
const navigation = new Set([
  "Return",
  "Tab",
  "Escape",
  "BackSpace",
  "Delete",
  "Up",
  "Down",
  "Left",
  "Right",
  "Home",
  "End",
  "Prior",
  "Next",
  "space",
]);
const selection = new Set(["Left", "Right", "Up", "Down", "Home", "End", "Prior", "Next"]);
const modifiers = new Set(["Control_L", "Shift_L", "Alt_L"]);

function safeCombination(combo: readonly string[]): boolean {
  if (new Set(combo).size !== combo.length) return false;
  const key = combo.at(-1);
  if (!key || modifiers.has(key)) return false;
  const prefix = combo.slice(0, -1);
  if (prefix.some((modifier) => !modifiers.has(modifier))) return false;
  if (prefix.length === 0) return navigation.has(key);
  if (prefix.length === 1 && prefix[0] === "Shift_L")
    return selection.has(key) || ["Tab", "Return", "Delete"].includes(key);
  if (prefix.length === 1 && prefix[0] === "Alt_L") return ["Left", "Right"].includes(key);
  if (prefix.length === 1 && prefix[0] === "Control_L")
    return [
      "a",
      "c",
      "v",
      "x",
      "z",
      "y",
      "f",
      "r",
      "Left",
      "Right",
      "Home",
      "End",
      "BackSpace",
      "Delete",
    ].includes(key);
  return (
    prefix.length === 2 &&
    prefix.includes("Control_L") &&
    prefix.includes("Shift_L") &&
    (selection.has(key) || key === "z" || key === "v")
  );
}

// These commands are issued only under BrowserControl's separate user permit.
// Agent `keys` keeps the narrower shortcut allowlist above.
function userCombination(combo: readonly string[]): boolean {
  const modifiers = new Set(["Control_L", "Shift_L", "Alt_L", "Super_L", "ISO_Level3_Shift"]);
  if (new Set(combo).size !== combo.length) return false;
  const key = combo.at(-1);
  return (
    !!key &&
    !modifiers.has(key) &&
    combo.slice(0, -1).every((name) => modifiers.has(name)) &&
    (navigation.has(key) ||
      ["Insert", "Menu", "Print"].includes(key) ||
      /^F(?:[1-9]|1[0-2])$/.test(key) ||
      /^[\x20-\x7e]$/.test(key))
  );
}

function safeCharacter(value: string): boolean {
  const point = value.codePointAt(0);
  return (
    Array.from(value).length === 1 &&
    point !== undefined &&
    (point === 9 ||
      point === 10 ||
      (point >= 32 && !(point >= 127 && point <= 159) && !(point >= 0xd800 && point <= 0xdfff)))
  );
}

function requests(scale: 1 | 2) {
  const position = {
    x: schema
      .number()
      .int()
      .min(0)
      .max(1280 * scale - 1),
    y: schema
      .number()
      .int()
      .min(0)
      .max(800 * scale - 1),
  };
  return {
    ping: empty,
    pointer: empty,
    windows: empty,
    activate: schema.strictObject({ window: windowId }),
    arm: empty,
    clearSelections: empty,
    surface: schema.strictObject({ window: windowId }),
    move: schema.strictObject(position),
    click: schema.strictObject({
      ...position,
      button: schema.number().int().min(1).max(3),
      count: schema.number().int().min(1).max(3),
      holdMs: schema.number().nonnegative().max(500),
      mods: schema
        .array(schema.enum(["Control_L", "Shift_L"]))
        .max(2)
        .refine((values) => new Set(values).size === values.length),
    }),
    scroll: schema.strictObject({
      ...position,
      dx: schema.number().int().min(-30).max(30),
      dy: schema.number().int().min(-30).max(30),
    }),
    char: schema.strictObject({
      ch: schema.string().refine(safeCharacter),
    }),
    keys: schema.strictObject({
      combo: schema.array(schema.string().min(1).max(16)).min(1).max(3).refine(safeCombination),
    }),
    userKeys: schema.strictObject({
      combo: schema.array(schema.string().min(1).max(16)).min(1).max(6).refine(userCombination),
    }),
    userClick: schema.strictObject({
      ...position,
      button: schema.number().int().min(1).max(3),
      count: schema.number().int().min(1).max(3),
      holdMs: schema.literal(0),
      mods: schema
        .array(schema.enum(["Control_L", "Shift_L", "Alt_L", "Super_L"]))
        .max(4)
        .refine((values) => new Set(values).size === values.length),
    }),
    settle: schema.strictObject({
      quietMs: schema.number().positive().max(5000),
      firstMs: schema.number().positive().max(10_000),
      timeoutMs: schema.number().positive().max(30_000),
    }),
  };
}

const replies = {
  ping: schema.strictObject({ mono }),
  pointer: schema.strictObject({ x: coordinate, y: coordinate }),
  windows: schema.strictObject({
    windows: schema
      .array(
        schema
          .strictObject({
            id: windowId,
            pid: schema.number().int().nonnegative().max(0x7fffffff),
            cls: schema.string().max(256),
            title: schema.string().max(4096),
            x: coordinate,
            y: coordinate,
            w: dimension,
            h: dimension,
            frame: schema.tuple([coordinate, coordinate, dimension, dimension]),
            active: schema.boolean(),
          })
          .transform(({ id, frame, active }) => ({ id, frame, active })),
      )
      .max(256),
  }),
  activate: schema.strictObject({
    active: schema.number().int().nonnegative().max(0xffffffff),
    changed: schema.boolean(),
    waitedMs: mono.max(5000),
    timedOut: schema.boolean().optional(),
  }),
  arm: schema.strictObject({ mono }),
  clearSelections: schema.strictObject({ cleared: schema.literal(true) }),
  surface: schema.strictObject({
    window: windowId,
    page: schema
      .strictObject({
        frame: schema.tuple([coordinate, coordinate, dimension, dimension]),
        windowFrame: schema.tuple([coordinate, coordinate, dimension, dimension]),
        urlHash: schema.string().regex(/^[a-f0-9]{64}$/u),
        focus: schema.enum(["page", "chrome", "unknown"]),
      })
      .nullable(),
  }),
  move: schema.strictObject({ mono }),
  click: schema.strictObject({
    button: schema.number().int().min(1).max(3),
    presses: schema.number().int().min(1).max(3),
  }),
  scroll: schema.strictObject({ notches: schema.number().int().nonnegative().max(60) }),
  char: schema.strictObject({
    keycode,
    mods: schema.array(schema.enum(["Shift_L", "ISO_Level3_Shift"])).max(2),
  }),
  keys: schema.strictObject({ keycodes: schema.array(keycode).min(1).max(3) }),
  userKeys: schema.strictObject({ keycodes: schema.array(keycode).min(1).max(6) }),
  userClick: schema.strictObject({
    button: schema.number().int().min(1).max(3),
    presses: schema.number().int().min(1).max(3),
  }),
  settle: schema.strictObject({
    changed: schema.array(schema.tuple([coordinate, coordinate, dimension, dimension])).max(8),
    lastChange: mono.nullable(),
    quiet: schema.boolean(),
    noVisibleChange: schema.boolean(),
  }),
};

export type NativeCommand = keyof typeof replies;
export type NativeArgs = {
  [Name in NativeCommand]: schema.infer<ReturnType<typeof requests>[Name]>;
};
export type NativeReplies = { [Name in NativeCommand]: schema.output<(typeof replies)[Name]> };

function captureArguments(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || types.isProxy(raw) || Array.isArray(raw)) return undefined;
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const names = Object.getOwnPropertyNames(raw);
  if (names.length > 8 || Object.getOwnPropertySymbols(raw).length !== 0) return undefined;
  const captured: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, name);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
      return undefined;
    const value: unknown = descriptor.value;
    if (typeof value === "string" && value.length <= 64) captured[name] = value;
    else if (typeof value === "number" && Number.isFinite(value)) captured[name] = value;
    else if (value && typeof value === "object" && !types.isProxy(value) && Array.isArray(value)) {
      if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > 6 ||
        Object.getOwnPropertyNames(value).length !== value.length + 1 ||
        Object.getOwnPropertySymbols(value).length !== 0
      )
        return undefined;
      const items: string[] = [];
      for (let position = 0; position < value.length; position += 1) {
        const item = Object.getOwnPropertyDescriptor(value, String(position));
        if (
          !item ||
          !Object.hasOwn(item, "value") ||
          !item.enumerable ||
          typeof item.value !== "string" ||
          item.value.length > 16
        )
          return undefined;
        items.push(item.value);
      }
      captured[name] = items;
    } else return undefined;
  }
  return captured;
}

export function nativeRequest(command: NativeCommand, args: unknown, scale: 1 | 2) {
  if (typeof command !== "string" || !Object.hasOwn(replies, command)) return undefined;
  const captured = captureArguments(args);
  if (!captured) return undefined;
  const parsed = requests(scale)[command].safeParse(captured);
  return parsed.success ? parsed.data : undefined;
}

export function nativeReply(
  command: NativeCommand,
  value: unknown,
  args: NativeArgs[NativeCommand],
) {
  const parsed = replies[command].safeParse(value);
  if (!parsed.success) return undefined;
  const reply = parsed.data;
  if (
    command === "surface" &&
    "window" in reply &&
    "window" in args &&
    reply.window !== args.window
  )
    return undefined;
  if (
    command === "activate" &&
    "active" in reply &&
    "window" in args &&
    (reply.active !== args.window || reply.timedOut === true)
  )
    return undefined;
  if (
    (command === "click" || command === "userClick") &&
    "button" in reply &&
    "button" in args &&
    (reply.button !== args.button || reply.presses !== args.count)
  )
    return undefined;
  if (
    command === "scroll" &&
    "notches" in reply &&
    "dx" in args &&
    reply.notches !== Math.abs(args.dx) + Math.abs(args.dy)
  )
    return undefined;
  if (
    (command === "keys" || command === "userKeys") &&
    "keycodes" in reply &&
    "combo" in args &&
    reply.keycodes.length !== args.combo.length
  )
    return undefined;
  return reply;
}

export const NativeEvent = schema.discriminatedUnion("kind", [
  schema.strictObject({
    ev: schema.enum(["press", "release"]),
    kind: schema.literal("key"),
    detail: keycode,
    mono,
  }),
  schema.strictObject({
    ev: schema.enum(["press", "release"]),
    kind: schema.literal("button"),
    detail: schema.number().int().min(1).max(32),
    mono,
  }),
]);
export type NativeEvent = schema.infer<typeof NativeEvent>;
export const NativeReady = schema.strictObject({ ev: schema.literal("ready"), mono });
export const NativeFailure = schema.strictObject({
  id: schema.number().int().positive(),
  ok: schema.literal(false),
  error: schema.string().max(4096),
});
