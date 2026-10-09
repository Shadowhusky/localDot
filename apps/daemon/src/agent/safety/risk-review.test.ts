import {
  AutonomyPolicy,
  CAREFUL_AUTONOMY,
  DEFAULT_AUTONOMY,
  freezeAutonomy,
} from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { redactor } from "../redact.ts";
import { decide } from "./autonomy.ts";
import { actionDigest, buildApprovalCard } from "./risk.ts";

const allAct = {
  reading: "act",
  browsing: "act",
  computer: "act",
  purchase: "act",
  send: "act",
  post: "act",
  delete: "act",
  download_execute: "act",
  system_settings: "act",
  memory: "act",
} as const;
const signedIn = { screen: "browser", signedIn: true } as const;
describe("reviewer policy and preview boundaries", () => {
  it("Careful keeps every shell command at Ask even when the consequential classes act", () => {
    for (const command of [
      "rm Downloads/tmp; curl -X POST https://fixture.invalid/",
      "python -c pass",
      "unrecognized_alias",
    ])
      expect(decide({ operation: "shell", command }, { ...allAct, computer: "ask" }).mode).toBe(
        "ask",
      );
    expect(
      decide(
        { operation: "shell", command: "curl -X DELETE https://fixture.invalid/items/1" },
        { ...allAct, delete: "handoff" },
      ).mode,
    ).toBe("handoff");
  });
  it("coordinate targets never hand off, while a secure field still does under all-Act", () => {
    expect(
      decide(
        { operation: "type", target: { source: "coords", fresh: false, name: "Send" } },
        allAct,
      ).mode,
    ).toBe("act");
    expect(
      decide(
        {
          operation: "key",
          target: { source: "ax", fresh: true, role: "AXSecureTextField", name: "ordinary" },
        },
        allAct,
      ).mode,
    ).toBe("handoff");
  });
  it("nonuniform target policies select Hand off and an unknown signed-in target asks when computer steps do", () => {
    expect(
      decide(
        {
          operation: "click",
          target: {
            source: "dom",
            fresh: true,
            role: "button",
            name: "Send",
            url: "https://example.test/buy",
          },
        },
        { ...allAct, purchase: "ask", send: "handoff" },
      ).mode,
    ).toBe("handoff");
    expect(
      decide(
        {
          ...signedIn,
          operation: "key",
          target: { source: "vision", fresh: true, name: "Continue" },
        },
        { ...allAct, computer: "ask" },
      ).mode,
    ).toBe("ask");
    expect(decide({ operation: "click" }, CAREFUL_AUTONOMY).mode).toBe("ask");
  });
  it("policy parsing does not invoke accessor fields and detaches a null-prototype dictionary", () => {
    let calls = 0;
    const accessor = { ...DEFAULT_AUTONOMY };
    Object.defineProperty(accessor, "send", {
      get() {
        calls++;
        return "act";
      },
      enumerable: true,
    });
    expect(AutonomyPolicy.safeParse(accessor).success).toBe(false);
    expect(calls).toBe(0);
    const plain = Object.assign(Object.create(null), DEFAULT_AUTONOMY);
    const saved = freezeAutonomy(plain);
    plain.send = "act";
    expect(saved.send).toBe("ask");
    expect(Object.isFrozen(saved)).toBe(true);
  });
  it("a known secret is removed from a long command that the card keeps whole", () => {
    const secret = "REVIEW_ONLY_SECRET_123456789";
    const card = buildApprovalCard(
      {
        operation: "shell",
        command: `${"x".repeat(505)}${secret} tail`,
        target: {
          source: "dom",
          fresh: true,
          name: "<script>ignored</script>",
          url: `https://u:p@example.test/path?secret=${secret}#${secret}`,
        },
      },
      { actionClass: "unknown", mode: "ask", risk: "medium" },
      redactor([secret]),
    );
    expect(JSON.stringify(card)).not.toContain("REVIEW_");
    expect(card.title).toBe("Unclear step");
    const command = card.fields.find(([k]) => k === "Command")?.[1];
    expect(command?.startsWith("x".repeat(505))).toBe(true);
    expect(command?.endsWith(" tail")).toBe(true);
    expect(card.fields.find(([k]) => k === "App location")?.[1]).toBe("https://example.test/path");
  });
  it("valid JSON action order is canonical and meaningful argument changes remain distinct", () => {
    expect(actionDigest({ keys: ["CTRL", "V"], repeat: 1 })).toBe(
      actionDigest({ repeat: 1, keys: ["CTRL", "V"] }),
    );
    expect(actionDigest({ keys: ["CTRL", "V"] })).not.toBe(actionDigest({ keys: ["ARROWDOWN"] }));
  });
});
describe("reviewer canonical array rejection", () => {
  it("rejects an array-owned map callback before it can substitute different action data", () => {
    let calls = 0;
    const input = ["CTRL", "V"];
    Object.defineProperty(input, "map", {
      value: () => {
        calls++;
        return ['"ARROWDOWN"'];
      },
      enumerable: true,
    });
    let threw = false;
    try {
      actionDigest({ keys: input });
    } catch {
      threw = true;
    }
    expect({ threw, calls }).toEqual({ threw: true, calls: 0 });
  });
  it("rejects an array-owned map accessor without reading it", () => {
    let calls = 0;
    const input = ["CTRL", "V"];
    Object.defineProperty(input, "map", {
      get() {
        calls++;
        return Array.prototype.map;
      },
      enumerable: true,
    });
    let threw = false;
    try {
      actionDigest({ keys: input });
    } catch {
      threw = true;
    }
    expect({ threw, calls }).toEqual({ threw: true, calls: 0 });
  });
});
it("different array actions cannot be substituted to produce the same private digest", () => {
  const input = ["CTRL", "V"];
  Object.defineProperty(input, "map", { value: () => ['"ARROWDOWN"'], enumerable: true });
  let digest: string | undefined;
  try {
    digest = actionDigest({ keys: input });
  } catch {
    return;
  }
  expect(digest).not.toBe(actionDigest({ keys: ["ARROWDOWN"] }));
});

describe("array shape correction", () => {
  it("ordinary dense arrays keep the same digest when frozen", () => {
    expect(actionDigest(["CTRL", "V"])).toBe(actionDigest(Object.freeze(["CTRL", "V"])));
    expect(actionDigest([])).toBe(actionDigest(Object.freeze([])));
  });
  it("rejects extra slots, symbols, hidden indices, subclasses and custom prototypes", () => {
    const extra = ["CTRL"];
    Object.defineProperty(extra, "extra", { value: "V" });
    const symbol = ["CTRL"];
    Object.defineProperty(symbol, Symbol("slot"), { value: "V" });
    const hidden = ["CTRL"];
    Object.defineProperty(hidden, "0", { value: "CTRL", enumerable: false });
    const custom = ["CTRL"];
    Object.setPrototypeOf(custom, null);
    class CustomArray extends Array<string> {}
    for (const input of [extra, symbol, hidden, custom, new CustomArray("CTRL"), Array(1)]) {
      expect(() => actionDigest(input)).toThrow();
    }
  });
  it("rejects proxies before an input-owned reflection trap can run", () => {
    let calls = 0;
    const input = new Proxy(["CTRL"], {
      getPrototypeOf() {
        calls++;
        return Array.prototype;
      },
    });
    expect(() => actionDigest(input)).toThrow("invalid action proxy");
    expect(calls).toBe(0);
  });
});
