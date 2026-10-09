import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakePushService, verifyVapid } from "../notify/testing/fake-push-service.ts";
import { KeydClient, KeydError } from "./client.ts";
import { type FakeKeyd, startFakeKeyd } from "./testing/fake-keyd.ts";

let keyd: FakeKeyd;
let client: KeydClient;
beforeEach(async () => {
  keyd = await startFakeKeyd();
  client = new KeydClient(keyd.socketPath, 2000);
});
afterEach(async () => {
  await keyd.close();
});

const message = Buffer.from("ciphertext").toString("base64url");

describe("KeydClient push", () => {
  it("reads the push key", async () => {
    expect(await client.pushKey()).toEqual({ publicKey: keyd.pushPublicKey });
  });

  it("hands keyd ciphertext only, and keyd signs a token that verifies against its key", async () => {
    const push = await startFakePushService();
    keyd.pushTarget = (endpoint) => `${push.url}${endpoint.pathname}`;
    try {
      const sent = await client.pushSend({
        endpoint: "https://web.push.apple.com/device-1",
        ttl: 600,
        urgency: "high",
        topic: "01J9ZQ4V5W6X7Y8Z9ABCDEFGHJ",
        body: message,
      });
      expect(sent).toEqual({ status: 201, gone: false });
      expect(keyd.calls.at(-1)).toEqual({
        method: "POST",
        path: "/v1/push/send",
        body: {
          endpoint: "https://web.push.apple.com/device-1",
          ttl: 600,
          urgency: "high",
          topic: "01J9ZQ4V5W6X7Y8Z9ABCDEFGHJ",
          body: message,
        },
      });
      const delivered = push.received[0];
      expect(delivered?.path).toBe("/device-1");
      expect(delivered?.body.toString()).toBe("ciphertext");
      expect(verifyVapid(delivered?.headers.authorization, keyd.pushPublicKey)).toMatchObject({
        aud: "https://web.push.apple.com",
      });
    } finally {
      await push.close();
    }
  });

  it("reports a gone subscription", async () => {
    const push = await startFakePushService();
    push.statuses.set("/old", 410);
    keyd.pushTarget = (endpoint) => `${push.url}${endpoint.pathname}`;
    try {
      await expect(
        client.pushSend({
          endpoint: "https://web.push.apple.com/old",
          ttl: 60,
          urgency: "normal",
          body: message,
        }),
      ).resolves.toEqual({ status: 410, gone: true });
    } finally {
      await push.close();
    }
  });

  it("refuses a malformed push reply from keyd", async () => {
    const request = {
      endpoint: "https://web.push.apple.com/x",
      ttl: 60,
      urgency: "normal",
      body: message,
    } as const;
    const badReply = { code: "bad-reply", status: 200 };
    for (const answer of [
      { status: "201", gone: false },
      { status: 201, gone: "no" },
      { status: 201 },
    ]) {
      keyd.replies.set("POST /v1/push/send", answer);
      await expect(client.pushSend(request)).rejects.toMatchObject(badReply);
    }
    for (const answer of [{ publicKey: "x" }, {}, { publicKey: `${keyd.pushPublicKey}=` }]) {
      keyd.replies.set("GET /v1/push/key", answer);
      await expect(client.pushKey()).rejects.toMatchObject(badReply);
    }
  });

  it("refuses a request it could not have sent before calling keyd", async () => {
    await expect(
      client.pushSend({
        endpoint: "https://web.push.apple.com/x",
        ttl: -1,
        urgency: "normal",
        body: message,
      }),
    ).rejects.toThrow();
    expect(keyd.calls).toHaveLength(0);
    await expect(
      client.pushSend({
        endpoint: "https://evil.example/x",
        ttl: 60,
        urgency: "normal",
        body: message,
      }),
    ).rejects.toBeInstanceOf(KeydError);
  });
});
