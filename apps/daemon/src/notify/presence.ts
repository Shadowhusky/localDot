import type { ClientPresence } from "@localdot/protocol";

export interface PresenceSnapshot {
  // A signed-in tab on this Mac is visible and focused: the person is looking at localDot.
  localVisible: boolean;
  // A signed-in tab on this Mac is open but hidden, and may show notifications itself.
  localHiddenCanNotify: boolean;
}

interface Client {
  local: boolean;
  visible: boolean;
  canNotify: boolean;
}

const ACK_WAIT_MS = 3_000;

// Who is looking, from the /api/events sockets. Only tabs on this Mac (a loopback Host) count:
// a phone that is open says nothing about whether the Mac's screen is seen.
export class PresenceBoard {
  readonly #clients = new Set<Client>();
  readonly #waiting = new Map<string, () => void>();

  shown(key: string): void {
    this.#waiting.get(key)?.();
  }

  // False after waitMs: the tab may be frozen or closed.
  waitForShown(key: string, waitMs = ACK_WAIT_MS): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(key);
        resolve(false);
      }, waitMs);
      this.#waiting.set(key, () => {
        clearTimeout(timer);
        this.#waiting.delete(key);
        resolve(true);
      });
    });
  }

  connect(local: boolean): { update(presence: ClientPresence): void; close(): void } {
    const client: Client = { local, visible: false, canNotify: false };
    this.#clients.add(client);
    return {
      update: (presence) => {
        client.visible = presence.visible;
        client.canNotify = presence.canNotify;
      },
      close: () => {
        this.#clients.delete(client);
      },
    };
  }

  snapshot(): PresenceSnapshot {
    let localVisible = false;
    let localHiddenCanNotify = false;
    for (const client of this.#clients) {
      if (!client.local) continue;
      if (client.visible) localVisible = true;
      else if (client.canNotify) localHiddenCanNotify = true;
    }
    return { localVisible, localHiddenCanNotify };
  }
}
