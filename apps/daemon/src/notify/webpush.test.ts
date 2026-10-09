import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeydPushRequest, KeydPushSent, PushPayload } from "@localdot/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NotifyStore } from "./store.ts";
import { browserKeys, decryptPush } from "./testing/ece-decrypt.ts";
import { WebPushSender } from "./webpush.ts";

const SESSION = "01J9ZQ4V5W6X7Y8Z9ABCDEFGHJ";
let home: string;
let store: NotifyStore;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ld-webpush-"));
  store = new NotifyStore(home);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function keyd(answers: (KeydPushSent | Error)[]) {
  const requests: KeydPushRequest[] = [];
  return {
    requests,
    pushSend: async (request: KeydPushRequest) => {
      requests.push(request);
      const next = answers.shift() ?? { status: 201, gone: false };
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

describe("WebPushSender", () => {
  it("encrypts the payload for each device and gives keyd ciphertext only", async () => {
    const phone = browserKeys();
    const tablet = browserKeys();
    store.subscribe({ endpoint: "https://web.push.apple.com/phone", keys: phone, label: "iPhone" });
    store.subscribe({
      endpoint: "https://fcm.googleapis.com/fcm/send/tab",
      keys: tablet,
      label: "Tablet",
    });
    const port = keyd([]);
    const sender = new WebPushSender({ keyd: port, store });
    const outcomes = await sender.sendAll(
      { kind: "needs_you", sessionId: SESSION },
      { ttl: 600, urgency: "high" },
    );
    expect(outcomes.map((o) => o.result)).toEqual(["sent", "sent"]);
    const toPhone = port.requests.find((r) => r.endpoint.endsWith("/phone"));
    expect(toPhone).toMatchObject({ ttl: 600, urgency: "high", topic: SESSION });
    expect(JSON.stringify(port.requests)).not.toContain("needs_you");
    const plain = decryptPush(
      Buffer.from(toPhone?.body ?? "", "base64url"),
      phone.privateKey,
      phone.authSecret,
    );
    expect(JSON.parse(plain.toString())).toEqual({ kind: "needs_you", sessionId: SESSION });
  });

  it("forgets a gone device, retries a busy service once and reports failures", async () => {
    const gone = store.subscribe({
      endpoint: "https://web.push.apple.com/gone",
      keys: browserKeys(),
      label: "Old",
    });
    let slept = 0;
    const sender = new WebPushSender({
      keyd: keyd([{ status: 410, gone: true }]),
      store,
      sleep: async () => {
        slept++;
      },
    });
    expect(
      (
        await sender.sendAll({ kind: "done", sessionId: SESSION }, { ttl: 60, urgency: "normal" })
      )[0],
    ).toEqual({
      id: gone.id,
      label: "Old",
      result: "gone",
    });
    expect(store.devices()).toEqual([]);

    store.subscribe({
      endpoint: "https://web.push.apple.com/busy",
      keys: browserKeys(),
      label: "Busy",
    });
    const busy = new WebPushSender({
      keyd: keyd([
        { status: 429, gone: false },
        { status: 201, gone: false },
      ]),
      store,
      sleep: async () => {
        slept++;
      },
    });
    expect(
      (await busy.sendAll({ kind: "done", sessionId: null }, { ttl: 60, urgency: "normal" }))[0]
        ?.result,
    ).toBe("sent");
    expect(slept).toBe(1);

    const down = new WebPushSender({ keyd: keyd([new Error("keyd offline")]), store });
    expect(
      (await down.sendAll({ kind: "done", sessionId: null }, { ttl: 60, urgency: "normal" }))[0]
        ?.result,
    ).toBe("failed");
    expect(store.devices()[0]?.lastResult).toBe("failed");
  });

  it("refuses a payload that carries anything but kind, session and title", async () => {
    store.subscribe({
      endpoint: "https://web.push.apple.com/phone",
      keys: browserKeys(),
      label: "iPhone",
    });
    const port = keyd([]);
    const sender = new WebPushSender({ keyd: port, store });
    const leaky = {
      kind: "done",
      sessionId: SESSION,
      text: "model words",
    } as unknown as PushPayload;
    await expect(sender.sendAll(leaky, { ttl: 60, urgency: "normal" })).rejects.toThrow();
    expect(port.requests).toEqual([]);
  });
});
