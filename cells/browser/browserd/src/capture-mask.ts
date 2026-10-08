import { types } from "node:util";

export const MAX_BROWSER_REDACTIONS = 256;
export type BrowserMaskRect = readonly [number, number, number, number];
export interface BrowserCaptureMask {
  readonly width: 1280 | 2560;
  readonly height: 800 | 1600;
  readonly content: BrowserMaskRect;
  readonly redactions: readonly BrowserMaskRect[];
}

function fields(raw: unknown, expected: readonly string[], array = false): unknown[] {
  if (!raw || typeof raw !== "object" || types.isProxy(raw)) throw new Error("capture mask");
  const prototype = Object.getPrototypeOf(raw);
  if (
    array
      ? !Array.isArray(raw) || prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  )
    throw new Error("capture mask");
  if (Object.getOwnPropertySymbols(raw).length) throw new Error("capture mask");
  const names = Object.getOwnPropertyNames(raw);
  if (
    names.length !== expected.length + Number(array) ||
    names.some((name) => !expected.includes(name) && !(array && name === "length"))
  )
    throw new Error("capture mask");
  return expected.map((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(raw, name);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
      throw new Error("capture mask");
    return descriptor.value;
  });
}

function rect(raw: unknown, width: number, height: number): BrowserMaskRect {
  const values = fields(raw, ["0", "1", "2", "3"], true);
  if (values.some((value) => typeof value !== "number" || !Number.isSafeInteger(value)))
    throw new Error("capture mask");
  const [left, top, extentX, extentY] = values as [number, number, number, number];
  if (
    left < 0 ||
    top < 0 ||
    extentX <= 0 ||
    extentY <= 0 ||
    left + extentX > width ||
    top + extentY > height
  )
    throw new Error("capture mask");
  return Object.freeze([left, top, extentX, extentY]);
}

export function captureMaskPacket(raw: unknown): Buffer {
  const [width, height, content, redactions] = fields(raw, [
    "width",
    "height",
    "content",
    "redactions",
  ]);
  if (!((width === 1280 && height === 800) || (width === 2560 && height === 1600)))
    throw new Error("capture mask");
  if (!Array.isArray(redactions) || types.isProxy(redactions)) throw new Error("capture mask");
  const length = Object.getOwnPropertyDescriptor(redactions, "length")?.value;
  if (!Number.isInteger(length) || length < 0 || length > MAX_BROWSER_REDACTIONS)
    throw new Error("capture mask");
  const page = rect(content, width, height);
  const masks = fields(
    redactions,
    Array.from({ length }, (_unused, position) => String(position)),
    true,
  ).map((entry) => rect(entry, width, height));
  const packet = Buffer.alloc(36 + masks.length * 16);
  const numbers = [0, 0, width, height, ...page, masks.length, ...masks.flat()];
  numbers.forEach((value, position) => {
    packet.writeUInt32BE(value, position * 4);
  });
  return packet;
}
