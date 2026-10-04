import { AutonomyPolicy, DEFAULT_AUTONOMY, freezeAutonomy } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { redactor } from "../redact.ts";
import { actionDigest, buildApprovalCard, classify } from "./risk.ts";

const allAct = {
  reading: "act",
  browsing: "act",
  purchase: "act",
  send: "act",
  post: "act",
  delete: "act",
  download_execute: "act",
  system_settings: "act",
} as const;
describe("reviewer policy and preview boundaries", () => {
  it("shell floor remains Ask under every editable class set to Act", () => {
    for (const command of [
      "rm Downloads/tmp; curl -X POST https://fixture.invalid/",
      "python -c pass",
      "unrecognized_alias",
    ])
      expect(classify({ operation: "shell", command }, allAct).mode).toBe("ask");
    expect(
      classify(
        { operation: "shell", command: "sudo defaults write fixture foo bar" },
        { ...allAct, system_settings: "handoff" },
      ).mode,
    ).toBe("handoff");
  });
  it("URL query ambiguity keeps an all-Act Send button at Ask and credentials remain Hand off", () => {
    expect(
      classify(
        {
          operation: "click",
          target: {
            source: "dom",
            fresh: true,
            name: "Send",
            url: "https://example.test/send?x=1",
          },
        },
        allAct,
      ).mode,
    ).toBe("ask");
    expect(
      classify(
        { operation: "type", target: { source: "coords", fresh: false, name: "Send" } },
        allAct,
      ).mode,
    ).toBe("handoff");
    expect(
      classify(
        {
          operation: "key",
          target: { source: "ax", fresh: true, role: "AXSecureTextField", name: "ordinary" },
        },
        allAct,
      ).mode,
    ).toBe("handoff");
  });
  it("nonuniform target policies select Hand off and unknown target still asks", () => {
    expect(
      classify(
        {
          operation: "click",
          target: { source: "dom", fresh: true, name: "Send", url: "https://example.test/buy" },
        },
        { ...allAct, purchase: "ask", send: "handoff" },
      ).mode,
    ).toBe("handoff");
    expect(
      classify(
        { operation: "key", target: { source: "dom", fresh: true, name: "Continue" } },
        allAct,
      ).mode,
    ).toBe("ask");
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
  it("a known secret crossing clipping boundary is removed before preview truncation", () => {
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
    expect(card.title).toBe("Review action");
    expect(card.fields.find(([k]) => k === "Command")?.[1]).toHaveLength(512);
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
