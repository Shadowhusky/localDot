import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encryptPush, MAX_PLAINTEXT } from "./ece.ts";
import { browserKeys, decryptPush } from "./testing/ece-decrypt.ts";

const b64u = (value: string) => Buffer.from(value, "base64url");
// RFC 8291 §5 and Appendix A.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  receiverPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  receiverPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  senderPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  message:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

describe("RFC 8291 encryption", () => {
  it("reproduces the RFC test vector byte for byte", () => {
    const message = encryptPush(
      Buffer.from(RFC.plaintext),
      b64u(RFC.receiverPublic),
      b64u(RFC.auth),
      { senderPrivate: b64u(RFC.senderPrivate), salt: b64u(RFC.salt) },
    );
    expect(message.toString("base64url")).toBe(RFC.message);
    expect(decryptPush(message, b64u(RFC.receiverPrivate), b64u(RFC.auth)).toString()).toBe(
      RFC.plaintext,
    );
  });

  it("round-trips a payload with a fresh key and salt each time", () => {
    const browser = browserKeys();
    const payload = Buffer.from('{"kind":"needs_you","sessionId":"01J9ZQ4V5W6X7Y8Z9ABCDEFGHJ"}');
    const a = encryptPush(payload, b64u(browser.p256dh), browser.authSecret);
    const b = encryptPush(payload, b64u(browser.p256dh), browser.authSecret);
    expect(a.subarray(0, 16).equals(b.subarray(0, 16))).toBe(false);
    expect(a.subarray(21, 86).equals(b.subarray(21, 86))).toBe(false);
    expect(decryptPush(a, browser.privateKey, browser.authSecret).equals(payload)).toBe(true);
    expect(a.includes(Buffer.from("needs_you"))).toBe(false);
  });

  it("refuses malformed keys and oversized text", () => {
    const browser = browserKeys();
    expect(() => encryptPush(Buffer.from("x"), randomBytes(33), browser.authSecret)).toThrow(
      RangeError,
    );
    expect(() => encryptPush(Buffer.from("x"), b64u(browser.p256dh), randomBytes(15))).toThrow(
      RangeError,
    );
    expect(() =>
      encryptPush(Buffer.alloc(MAX_PLAINTEXT + 1), b64u(browser.p256dh), browser.authSecret),
    ).toThrow(RangeError);
    expect(
      encryptPush(Buffer.alloc(MAX_PLAINTEXT), b64u(browser.p256dh), browser.authSecret).length,
    ).toBe(4096);
  });
});
