import { describe, expect, it } from "vitest";
import { run } from "./cli.ts";
import { toyRig } from "./toy.ts";

const memory = (files: Record<string, string>) => {
  const written: Record<string, string> = {};
  const errors: string[] = [];
  const io = {
    read: (p: string) => {
      const text = files[p];
      if (text === undefined) throw new Error(`ENOENT: ${p}`);
      return text;
    },
    write: (p: string, t: string) => {
      written[p] = t;
    },
    error: (m: string) => {
      errors.push(m);
    },
  };
  return { io, written, errors };
};

describe("rig-gen CLI", () => {
  it("writes the skeleton for a valid description", () => {
    const m = memory({ "rig-description.json": JSON.stringify(toyRig()) });
    expect(run(["rig-description.json", "rig.json"], m.io)).toBe(0);
    expect(JSON.parse(m.written["rig.json"] ?? "{}").skeleton.spine).toBe("4.3.26");
  });

  it("reports every problem and writes nothing for an invalid description", () => {
    const bad = { ...toyRig(), bones: [{ name: "x", parent: "nope", at: { x: 0, y: 0 } }] };
    const m = memory({ "in.json": JSON.stringify(bad) });
    expect(run(["in.json", "out.json"], m.io)).toBe(1);
    expect(m.written).toEqual({});
    expect(m.errors.join("\n")).toContain('parent "nope"');
  });

  it("explains unreadable input", () => {
    const m = memory({ "in.json": "{ not json" });
    expect(run(["in.json", "out.json"], m.io)).toBe(1);
    expect(run(["missing.json", "out.json"], m.io)).toBe(1);
    expect(m.errors.join("\n")).toContain("cannot read");
  });

  it("prints usage for the wrong arguments", () => {
    const m = memory({});
    expect(run(["only-one"], m.io)).toBe(2);
    expect(m.errors[0]).toContain("usage: rig-gen");
  });
});
