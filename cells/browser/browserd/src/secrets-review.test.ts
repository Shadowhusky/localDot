import { describe, expect, it, vi } from "vitest";
import { BrowserControl } from "./control.ts";
import type { BrowserNative } from "./native.ts";
import { BrowserSecrets, secretMetadata, verificationField } from "./secrets.ts";
import type { BrowserDocument } from "./targets.ts";

function snapshot(tag: string, attributes: Record<string, string>, value: string) {
  const strings: string[] = [];
  const intern = (text: string) => strings.push(text) - 1;
  const nodes = {
    nodeName: [intern(tag)],
    backendNodeId: [1],
    attributes: [Object.entries(attributes).flatMap(([key, item]) => [intern(key), intern(item)])],
    inputValue: { index: [] as number[], value: [] as number[] },
    textValue: { index: [] as number[], value: [] as number[] },
  };
  const column = tag === "TEXTAREA" ? nodes.textValue : nodes.inputValue;
  column.index.push(0);
  column.value.push(intern(value));
  return { strings, documents: [{ nodes }] };
}
function protectedTextarea() {
  return snapshot("TEXTAREA", { type: "button", autocomplete: "one-time-code" }, "synthetic-otp");
}
function composed(raw: unknown) {
  const document: BrowserDocument = Object.freeze({ tabId: "tab", revision: 1, frame: false });
  const reload = vi.fn(async () => {});
  const targets = {
    tabs: () => [{ id: "tab", ready: true }],
    documents: () => [document],
    check: (value: BrowserDocument) => {
      if (value !== document) throw new Error("stale");
    },
    command: async () => raw as Record<string, unknown>,
    reload,
  };
  const native = { command: vi.fn(async () => ({ cleared: true })) } as unknown as Pick<
    BrowserNative,
    "command"
  >;
  const secrets = new BrowserSecrets(targets, native);
  const identity = {
    browserCellId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0N",
    parentCellId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0M",
    instance: "87ae386e-79f1-4f3e-b604-869812515446",
  };
  const control = new BrowserControl({
    ...identity,
    clearSelections: (s) => secrets.clearSelections(s),
    secretPages: (s) => secrets.secretPages(s),
    reload: (id, s) => secrets.reload(id, s),
  });
  const request = {
    ...identity,
    requestId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0K",
    revision: 1,
    holder: "agent",
    owner: { sessionId: "01J9ZQ3V8Y7X6W5T4S3R2Q1P0K", generation: 1 },
  };
  return { control, request, reload };
}

describe("independent secret projection and handback", () => {
  it("a textarea cannot lose protected live text because of an irrelevant input type attribute", () => {
    expect(secretMetadata(protectedTextarea())).toEqual({ filled: true, nodeIds: [1] });
  });
  it("persistent protected textarea prevents actual BrowserControl agent authority", async () => {
    const f = composed(protectedTextarea());
    try {
      const outcome = await f.control.set(f.request).then(
        () => "granted",
        () => "refused",
      );
      expect(outcome).toBe("refused");
      expect(f.control.holder).toBe("user");
      expect(f.reload).toHaveBeenCalledTimes(1);
    } finally {
      await f.control.close();
    }
  });
  it("P4 protected live and retained password values project only immutable metadata", () => {
    const result = secretMetadata(snapshot("INPUT", { type: "password" }, "private-live-canary"));
    expect(result).toEqual({ filled: true, nodeIds: [1] });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.nodeIds)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("canary");
    expect(
      secretMetadata(snapshot("INPUT", { type: "password", value: "private-retained-canary" }, "")),
    ).toEqual({ filled: true, nodeIds: [1] });
  });
  it("P5 pending sibling-document invalidation prevents a partial empty scan", async () => {
    const documents: BrowserDocument[] = [
      Object.freeze({ tabId: "tab", revision: 1, frame: false }),
      Object.freeze({ tabId: "tab", revision: 1, frame: true }),
    ];
    let revoked = false;
    const targets = {
      tabs: () => [{ id: "tab", ready: true }],
      documents: () => documents,
      check: (document: BrowserDocument) => {
        if (revoked && document === documents[0]) throw new Error("stale");
      },
      command: async (document: BrowserDocument) => {
        if (document === documents[1]) revoked = true;
        return snapshot("INPUT", { autocomplete: "username" }, "synthetic-user");
      },
      reload: async () => {},
    };
    const native = { command: async () => ({ cleared: true }) } as unknown as Pick<
      BrowserNative,
      "command"
    >;
    const secrets = new BrowserSecrets(targets, native);
    await expect(secrets.secretPages(new AbortController().signal)).rejects.toThrow("stale");
  });
  it("P1 ordinary button and filled username remain outside protected-field metadata", () => {
    expect(
      secretMetadata(snapshot("INPUT", { type: "button", name: "password-toggle" }, "Show")),
    ).toEqual({ filled: false, nodeIds: [] });
    expect(
      secretMetadata(snapshot("INPUT", { autocomplete: "username" }, "synthetic-user")),
    ).toEqual({ filled: false, nodeIds: [] });
  });
  it("P2 empty protected textarea permits handback without reloading ordinary content", async () => {
    const f = composed(snapshot("TEXTAREA", { autocomplete: "one-time-code" }, ""));
    try {
      await expect(f.control.set(f.request)).resolves.toMatchObject({
        holder: "agent",
        reloaded: 0,
      });
      expect(f.reload).not.toHaveBeenCalled();
    } finally {
      await f.control.close();
    }
  });
});

describe("shared private verification-field detection", () => {
  it.each([
    "sms_otp",
    "email-verification-code",
    "totp",
    "recovery_code",
    "backup-code",
    "security_code",
    "account_pin",
  ])("masks and privately delivers %s", (name) => {
    expect(verificationField(new Map([["name", name]]))).toBe(true);
  });
  it.each(["zip_code", "coupon_code", "shipping", "spinning", "account_email"])(
    "does not treat %s as an authentication secret",
    (name) => {
      expect(verificationField(new Map([["name", name]]))).toBe(false);
    },
  );
});
