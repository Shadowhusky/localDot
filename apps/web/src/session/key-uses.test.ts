import { describe, expect, it } from "vitest";
import { type KeyUseState, keyUseRow, timelineRows } from "./key-uses.ts";

const use = (t: number, over: Partial<KeyUseState> = {}): KeyUseState => ({
  id: `k${t}`,
  t,
  secretId: "weather",
  host: "api.weather.example",
  method: "GET",
  path: "/v1/now",
  decision: "allow",
  ...over,
});

describe("keyUseRow", () => {
  it("describes allowed and refused requests without turning request text into markup", () => {
    expect(keyUseRow(use(1))).toMatchObject({
      label: "Used weather key → api.weather.example",
      detail: "GET /v1/now",
      blocked: false,
      count: 1,
    });
    for (const decision of ["deny", "ask"] as const) {
      expect(
        keyUseRow(use(1, { decision, secretId: "unknown", host: "evil.example" })),
      ).toMatchObject({ label: "Blocked an unknown key → evil.example", blocked: true });
    }
    expect(
      keyUseRow(use(1, { host: "<img src=x onerror=alert(1)>", path: "/[surrogate:123]" })),
    ).toMatchObject({
      label: "Used weather key → <img src=x onerror=alert(1)>",
      detail: "GET /[surrogate:123]",
    });
  });
});

describe("timelineRows", () => {
  it("sorts chronologically and folds only consecutive matching key uses", () => {
    const rows = timelineRows(
      [
        { id: "s2", startT: 50 },
        { id: "s1", startT: 10 },
      ],
      [use(60), use(22), use(30, { decision: "deny" }), use(20), use(21, { path: "/v1/later" })],
    );
    expect(rows.map((r) => (r.kind === "step" ? r.id : `${r.label} ×${r.count}`))).toEqual([
      "s1",
      "Used weather key → api.weather.example ×3",
      "Blocked weather key → api.weather.example ×1",
      "s2",
      "Used weather key → api.weather.example ×1",
    ]);
    expect(rows[1]).toMatchObject({ id: "k20", t: 20, detail: "GET /v1/now" });
  });

  it("ends a group at each step, key, host, and exact outcome boundary", () => {
    const rows = timelineRows(
      [{ id: "s1", startT: 7 }],
      [
        use(1),
        use(2, { path: "/latest", method: "POST" }),
        use(3, { decision: "deny" }),
        use(4, { decision: "ask" }),
        use(5, { secretId: "other" }),
        use(6, { host: "different.example" }),
        use(8, { host: "different.example" }),
        use(9),
      ],
    );
    expect(rows.map((r) => (r.kind === "step" ? r.id : [r.id, r.count]))).toEqual([
      ["k1", 2],
      ["k3", 1],
      ["k4", 1],
      ["k5", 1],
      ["k6", 1],
      "s1",
      ["k8", 1],
      ["k9", 1],
    ]);
    expect(rows[0]).toMatchObject({ detail: "POST /latest" });
  });

  it("compares the actual key and host even if labels collide", () => {
    const rows = timelineRows(
      [],
      [use(1, { secretId: "a key → b", host: "c" }), use(2, { secretId: "a", host: "b key → c" })],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ label: "Used a key → b key → c", count: 1 });
    expect(rows[1]).toMatchObject({ label: "Used a key → b key → c", count: 1 });
  });

  it("keeps ties stable, placing step starts before equally timed key events", () => {
    const rows = timelineRows(
      [
        { id: "s2", startT: 10 },
        { id: "s1", startT: 10 },
      ],
      [
        use(10, { id: "k2", decision: "deny" }),
        use(10, { id: "k1", decision: "allow" }),
        use(10, { id: "k3", decision: "ask" }),
      ],
    );
    expect(rows.map((r) => r.id)).toEqual(["s2", "s1", "k2", "k1", "k3"]);
  });

  it("leaves the inputs and previously built timelines unchanged after later uses", () => {
    const steps = Object.freeze([Object.freeze({ id: "s1", startT: 1 })]);
    const keyUses = Object.freeze([Object.freeze(use(2)), Object.freeze(use(3))]);
    const first = timelineRows(steps, keyUses);
    const snapshot = structuredClone(first);
    const second = timelineRows(steps, [...keyUses, use(4, { path: "/later" })]);
    expect(first).toEqual(snapshot);
    expect(first[0]).not.toBe(steps[0]);
    expect(first[1]).toMatchObject({ count: 2, detail: "GET /v1/now" });
    expect(second[1]).toMatchObject({ count: 3, detail: "GET /later" });
    expect(keyUses.map((k) => k.path)).toEqual(["/v1/now", "/v1/now"]);
  });
});
