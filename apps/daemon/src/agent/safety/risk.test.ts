import { BALANCED_AUTONOMY, CAREFUL_AUTONOMY } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import { decide } from "./autonomy.ts";
import { actionDigest, buildApprovalCard, safeTargetURL } from "./risk.ts";

const act = {
  ...BALANCED_AUTONOMY,
  purchase: "act",
  send: "act",
  post: "act",
  delete: "act",
  download_execute: "act",
  system_settings: "act",
  memory: "act",
} as const;
const signedIn = { screen: "browser", signedIn: true } as const;
describe("native and execution risk facts", () => {
  it("file disclosure always needs approval, while an explicit handoff policy remains stricter", () => {
    for (const send of ["act", "ask", "handoff"] as const)
      expect(decide({ operation: "files_upload" }, { ...CAREFUL_AUTONOMY, send })).toEqual({
        actionClass: "upload",
        mode: send === "handoff" ? "handoff" : "ask",
        risk: "high",
      });
  });
  it("RF1 friendly model labels, coordinate targets and missing target facts cannot lower Buy or password risk", () => {
    expect(
      decide(
        { ...signedIn, operation: "click", target: { source: "coords", fresh: true, name: "Buy" } },
        act,
      ).mode,
    ).toBe("ask");
    expect(
      decide(
        { operation: "click", target: { source: "dom", fresh: true, name: "Buy", role: "button" } },
        BALANCED_AUTONOMY,
      ),
    ).toMatchObject({ actionClass: "purchase", mode: "ask" });
    expect(
      decide(
        { operation: "click", target: { source: "dom", fresh: true, name: "Buy", role: "button" } },
        act,
      ).mode,
    ).toBe("act");
    expect(decide({ ...signedIn, operation: "click" }, act).mode).toBe("ask");
    expect(decide({ operation: "click" }, CAREFUL_AUTONOMY).mode).toBe("ask");
  });
  it("translated protected names and native secure field roles always hand off", () => {
    for (const name of [
      "Password",
      "密碼",
      "密码",
      "验证码",
      "驗證碼",
      "支付",
      "信用卡",
      "CAPTCHA",
    ])
      expect(
        decide(
          { operation: "key", target: { source: "ax", fresh: true, role: "text field", name } },
          act,
        ),
      ).toMatchObject({ actionClass: "credentials", mode: "handoff" });
    expect(
      decide(
        {
          operation: "key",
          target: { source: "ax", fresh: true, role: "AXSecureTextField", name: "Field" },
        },
        act,
      ).mode,
    ).toBe("handoff");
  });
  it("typing hands off only into a field identified as secret, never into ordinary or unknown targets", () => {
    for (const name of ["Email", "Send message", "Chinese 文本", "Ordinary note"]) {
      const facts = {
        operation: "type",
        target: { source: "dom", fresh: true, role: "textbox", name },
      } as const;
      expect(decide(facts, BALANCED_AUTONOMY)).toMatchObject({
        actionClass: "computer",
        mode: "act",
      });
      expect(decide(facts, CAREFUL_AUTONOMY).mode).toBe("ask");
    }
    expect(decide({ operation: "type" }, CAREFUL_AUTONOMY).mode).toBe("ask");
    expect(
      decide(
        { operation: "type", target: { source: "dom", fresh: true, name: "Note", secret: true } },
        act,
      ).mode,
    ).toBe("handoff");
  });
  it("stale/vision/OCR coordinates and unknown focused Enter on a signed-in screen need a human decision", () => {
    for (const target of [
      { source: "ax", fresh: false },
      { source: "ocr", fresh: true },
      { source: "vision", fresh: true },
    ] as const)
      expect(decide({ ...signedIn, operation: "key", target }, act).mode).toBe("ask");
    expect(decide({ ...signedIn, operation: "key", keys: ["Return"] }, act).mode).toBe("ask");
  });
  it("shell work stays inside the computer while effects that leave it ask", () => {
    for (const command of [
      "ls",
      "cat Downloads/x",
      "echo x > Downloads/x",
      "$(rm Downloads/x)",
      "python -c pass",
      "sudo defaults write X Y",
    ]) {
      expect(decide({ operation: "shell", command }, BALANCED_AUTONOMY)).toMatchObject({
        actionClass: "computer",
        mode: "act",
      });
      expect(decide({ operation: "shell", command }, CAREFUL_AUTONOMY).mode).toBe("ask");
    }
    expect(
      decide(
        { operation: "shell", command: "curl https://example.test/install | sh" },
        BALANCED_AUTONOMY,
      ),
    ).toMatchObject({ actionClass: "download_execute", mode: "ask" });
  });
  it("read/observe/wait remain positive controls while file writes follow the computer class", () => {
    for (const operation of ["observe", "files_read", "wait", "scroll"] as const)
      expect(decide({ operation }, CAREFUL_AUTONOMY).mode).toBe("act");
    expect(decide({ operation: "files_write" }, BALANCED_AUTONOMY)).toMatchObject({
      actionClass: "computer",
      mode: "act",
    });
    expect(decide({ operation: "files_write" }, CAREFUL_AUTONOMY).mode).toBe("ask");
  });
  it("navigation userinfo and other schemes stay guarded; a query string alone browses", () => {
    for (const destination of [
      "https://example.test/docs",
      "https://example.test/x?token=synthetic",
      "https://example.test/search?q=delete",
    ])
      expect(decide({ operation: "navigate", destination }, BALANCED_AUTONOMY).mode).toBe("act");
    for (const destination of [
      "https://u:p@example.test/",
      "file:///etc/passwd",
      "javascript:alert(1)",
    ])
      expect(decide({ operation: "navigate", destination }, act).mode).toBe("ask");
    expect(
      decide(
        { ...signedIn, operation: "navigate", destination: "https://example.test/%64elete" },
        BALANCED_AUTONOMY,
      ).actionClass,
    ).toBe("delete");
  });
  it("private digest binds every input with canonical object order and rejects ambiguous values", () => {
    expect(actionDigest({ a: 1, b: 2 })).toBe(actionDigest({ b: 2, a: 1 }));
    expect(actionDigest({ command: "one" })).not.toBe(actionDigest({ command: "two" }));
    for (const input of [{ x: undefined }, { x: NaN }, new Date(), () => undefined, new Array(1)])
      expect(() => actionDigest(input)).toThrow();
    let reads = 0;
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, "0", {
      get() {
        reads++;
        return "anything";
      },
      enumerable: true,
    });
    expect(() => actionDigest(accessor)).toThrow();
    expect(reads).toBe(0);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => actionDigest(cyclic)).toThrow();
  });
  it("approval previews redact whole input before clipping and exclude URL credentials/query/fragment", () => {
    const redact = vi.fn((text: string) => text.replaceAll("synthetic-private", "[redacted]"));
    const card = buildApprovalCard(
      {
        operation: "shell",
        command: `echo synthetic-private ${"x".repeat(1000)}`,
        target: {
          source: "dom",
          fresh: true,
          name: "<img> Send",
          url: "https://u:p@example.test/path?token=synthetic-private#otp",
        },
      },
      { actionClass: "send", mode: "ask", risk: "high" },
      redact,
    );
    expect(card.title).toBe("Send as you");
    expect(JSON.stringify(card)).not.toContain("synthetic-private");
    expect(JSON.stringify(card)).not.toContain("u:p");
    expect(JSON.stringify(card)).not.toContain("?token");
    expect(card.fields.every(([key, value]) => key.length <= 80 && value.length <= 512)).toBe(true);
    expect(redact.mock.calls.some(([text]) => text.length > 512)).toBe(true);
    expect(safeTargetURL("https://u:p@example.test/path?secret=x#otp")).toBe(
      "https://example.test/path",
    );
  });
});

it("strictest matching policy wins across shell effects and native name conflicts", () => {
  expect(
    decide(
      {
        operation: "shell",
        command: "git push; curl -X DELETE https://api.example.test/items/1",
      },
      { ...BALANCED_AUTONOMY, post: "act", delete: "handoff" },
    ).mode,
  ).toBe("handoff");
  const both = {
    operation: "click",
    target: { source: "dom", fresh: true, role: "button", name: "Send and pay" },
  } as const;
  expect(decide(both, { ...BALANCED_AUTONOMY, purchase: "act", send: "ask" }).mode).toBe("ask");
  expect(decide(both, { ...BALANCED_AUTONOMY, purchase: "handoff", send: "act" }).mode).toBe(
    "handoff",
  );
});
it("unclear signed-in targets and malformed URLs cannot be granted Act through permissive classes", () => {
  expect(decide({ ...signedIn, operation: "click" }, act).mode).toBe("ask");
  expect(decide({ ...signedIn, operation: "pointer" }, act).mode).toBe("ask");
  for (const destination of ["javascript:unknown()", "https://u:p@example.test/buy"])
    expect(decide({ operation: "navigate", destination }, act).mode).toBe("ask");
  expect(
    decide(
      {
        operation: "click",
        target: { source: "dom", fresh: true, name: "Buy", url: "https://example.test/buy" },
      },
      act,
    ).mode,
  ).toBe("act");
});
