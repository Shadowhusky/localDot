import { type SecretBinding, sealSecret } from "@localdot/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KeydClient } from "./client.ts";
import { KEYD_TESTS, type KeydProcess, startKeyd } from "./testing/keyd-process.ts";

let keyd: KeydProcess;
let client: KeydClient;

describe.skipIf(!KEYD_TESTS)("Web Push through the real keyd", () => {
  beforeAll(async () => {
    keyd = await startKeyd();
    client = new KeydClient(keyd.socketPath);
  });
  afterAll(async () => {
    await keyd?.stop();
  });

  it("keeps one push key across calls", async () => {
    const first = await client.pushKey();
    expect(first.publicKey).toMatch(/^B[A-Za-z0-9_-]{86}$/);
    expect(await client.pushKey()).toEqual(first);
  });

  it("refuses an endpoint that is not a browser push service without dialling it", async () => {
    await expect(
      client.pushSend({
        endpoint: "https://evil.example/collect",
        ttl: 60,
        urgency: "normal",
        body: Buffer.from("ciphertext").toString("base64url"),
      }),
    ).rejects.toMatchObject({ status: 400, code: "not-push-service" });
  });

  it("never lets a user key take the push key's name", async () => {
    const binding: SecretBinding = {
      id: "webpush-vapid",
      kind: "http",
      hosts: ["api.example.test"],
      header: "Authorization",
      format: "bearer",
    } as unknown as SecretBinding;
    const sealed = await sealSecret(
      (await client.status()).sealKey,
      binding,
      "real-secret-value-for-test",
    );
    await expect(client.putSecret(binding, sealed)).rejects.toMatchObject({ status: 400 });
  });
});
