import type { AppEvents } from "../app-events.ts";
import type { EventLog } from "../event-log.ts";
import type { KeydClient } from "../keyd/client.ts";
import { AttentionLedger } from "./attention.ts";
import { type MacNotifier, macNotifier } from "./mac.ts";
import { isRoutineRun, Notifier } from "./notifier.ts";
import { PresenceBoard } from "./presence.ts";
import type { NotifyRoutesDeps } from "./routes.ts";
import { NotifyStore } from "./store.ts";
import { WebPushSender } from "./webpush.ts";

export interface NotifyWiringDeps {
  home: string;
  eventLog: Pick<EventLog, "subscribe">;
  keyd: Pick<KeydClient, "pushKey" | "pushSend">;
  events: Pick<AppEvents, "publish" | "subscribe">;
  mac?: MacNotifier;
  now?: () => Date;
  timeZone?: () => string;
  settleMs?: number;
}

export interface NotifyWiring {
  store: NotifyStore;
  ledger: AttentionLedger;
  presence: PresenceBoard;
  notifier: Notifier;
  routes: NotifyRoutesDeps;
  close(): void;
}

export function createNotify(d: NotifyWiringDeps): NotifyWiring {
  const now = d.now ?? (() => new Date());
  const store = new NotifyStore(d.home, now);
  const ledger = new AttentionLedger(() => now().getTime());
  const presence = new PresenceBoard();
  const notifier = new Notifier({
    ledger,
    store,
    mac: d.mac ?? macNotifier(),
    push: new WebPushSender({ keyd: d.keyd, store }),
    presence,
    publish: (event) => d.events.publish(event),
    routineRuns: (listener) =>
      d.events.subscribe((event) => {
        if (isRoutineRun(event)) listener(event);
      }),
    now,
    timeZone: d.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone),
    ...(d.settleMs === undefined ? {} : { settleMs: d.settleMs }),
  });
  const unobserve = d.eventLog.subscribe((sessionId, event) => ledger.observe(sessionId, event));
  const stop = notifier.start();
  return {
    store,
    ledger,
    presence,
    notifier,
    routes: { store, keyd: d.keyd, ledger, notifier },
    close() {
      stop();
      unobserve();
    },
  };
}
