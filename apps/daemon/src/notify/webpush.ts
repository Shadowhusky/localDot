import { type KeydPushRequest, type KeydPushSent, PushPayload } from "@localdot/protocol";
import { encryptPush } from "./ece.ts";
import type { NotifyStore, StoredSubscription } from "./store.ts";

export interface PushPort {
  pushSend(request: KeydPushRequest): Promise<KeydPushSent>;
}

export interface PushOutcome {
  id: string;
  label: string;
  result: "sent" | "gone" | "failed";
}

export interface PushOptions {
  ttl: number;
  urgency: "normal" | "high";
}

const RETRY_MS = 2_000;
const retryable = (status: number) => status === 429 || status >= 500;

export class WebPushSender {
  constructor(
    private readonly deps: {
      keyd: PushPort;
      store: Pick<NotifyStore, "subscriptions" | "recordResult">;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  async sendAll(payload: PushPayload, options: PushOptions): Promise<PushOutcome[]> {
    // The last check before anything leaves the Mac: kind, session and the opted-in title only.
    const plain = Buffer.from(JSON.stringify(PushPayload.parse(payload)));
    return Promise.all(
      this.deps.store
        .subscriptions()
        .map((subscription) => this.#send(subscription, plain, payload.sessionId, options)),
    );
  }

  async #send(
    subscription: StoredSubscription,
    plain: Buffer,
    sessionId: string | null,
    options: PushOptions,
  ): Promise<PushOutcome> {
    const outcome = (result: PushOutcome["result"]): PushOutcome => {
      this.deps.store.recordResult(subscription.id, result);
      return { id: subscription.id, label: subscription.label, result };
    };
    const attempt = () =>
      this.deps.keyd.pushSend({
        endpoint: subscription.endpoint,
        ttl: options.ttl,
        urgency: options.urgency,
        ...(sessionId ? { topic: sessionId } : {}),
        body: encryptPush(
          plain,
          Buffer.from(subscription.keys.p256dh, "base64url"),
          Buffer.from(subscription.keys.auth, "base64url"),
        ).toString("base64url"),
      });
    try {
      let sent = await attempt();
      if (retryable(sent.status)) {
        await (this.deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
          RETRY_MS,
        );
        sent = await attempt();
      }
      if (sent.gone) return outcome("gone");
      if (sent.status >= 200 && sent.status < 300) return outcome("sent");
      console.error(`a phone notification was refused (status ${sent.status})`);
      return outcome("failed");
    } catch {
      console.error("a phone notification could not be sent");
      return outcome("failed");
    }
  }
}
