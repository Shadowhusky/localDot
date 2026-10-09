import { describe, expect, it } from "vitest";
import { qrModules } from "./qr.ts";

// The 15 format bits read back from the copy beside the top-left finder.
function formatBits(modules: boolean[][]): number {
  const at = (x: number, y: number) => (modules[y]?.[x] ? 1 : 0);
  const order: [number, number][] = [
    [8, 0],
    [8, 1],
    [8, 2],
    [8, 3],
    [8, 4],
    [8, 5],
    [8, 7],
    [8, 8],
    [7, 8],
    [5, 8],
    [4, 8],
    [3, 8],
    [2, 8],
    [1, 8],
    [0, 8],
  ];
  return order.reduce((bits, [x, y], i) => bits | (at(x, y) << i), 0);
}

const finder = (modules: boolean[][], left: number, top: number) =>
  Array.from({ length: 7 }, (_, y) =>
    Array.from({ length: 7 }, (_, x) => (modules[top + y]?.[left + x] ? "#" : ".")).join(""),
  );

describe("qrModules", () => {
  it("picks the smallest version that holds the text", () => {
    expect(qrModules("A")?.length).toBe(21);
    expect(qrModules("https://pair.example.test/a1b2c3")?.length).toBe(29);
    expect(qrModules("x".repeat(300))?.length).toBe(69);
    expect(qrModules("x".repeat(3000))).toBeNull();
  });

  it("draws the three finders, the timing lines and the dark module", () => {
    const modules = qrModules("https://pair.example.test/a1b2c3") as boolean[][];
    const size = modules.length;
    const square = ["#######", "#.....#", "#.###.#", "#.###.#", "#.###.#", "#.....#", "#######"];
    expect(finder(modules, 0, 0)).toEqual(square);
    expect(finder(modules, size - 7, 0)).toEqual(square);
    expect(finder(modules, 0, size - 7)).toEqual(square);
    for (let i = 8; i < size - 8; i++) {
      expect(modules[6]?.[i]).toBe(i % 2 === 0);
      expect(modules[i]?.[6]).toBe(i % 2 === 0);
    }
    expect(modules[size - 8]?.[8]).toBe(true);
  });

  it("writes valid format bits for medium error correction", () => {
    const bits = formatBits(qrModules("Hello, world!") as boolean[][]) ^ 0x5412;
    let rem = bits >>> 10;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    expect(bits & 0x3ff).toBe(rem & 0x3ff);
    expect(bits >>> 13).toBe(0);
  });
});
