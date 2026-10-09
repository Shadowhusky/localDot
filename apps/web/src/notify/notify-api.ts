import {
  AttentionSnapshot,
  NotifyKey,
  NotifySettings,
  NotifyTestResult,
  PushDevice,
  PushDeviceList,
  type PushSubscriptionInput,
} from "@localdot/protocol";
import type { ApiClient } from "../lib/api.ts";

export type NotifyApi = ReturnType<typeof notifyApi>;

export function notifyApi(api: ApiClient) {
  return {
    settings: async () => NotifySettings.parse(await api.get("/api/notify/settings")),
    saveSettings: async (settings: NotifySettings) =>
      NotifySettings.parse(await api.put("/api/notify/settings", settings)),
    key: async () => NotifyKey.parse(await api.get("/api/notify/key")).publicKey,
    devices: async () => PushDeviceList.parse(await api.get("/api/notify/subscriptions")).devices,
    addDevice: async (input: PushSubscriptionInput) =>
      PushDevice.parse(await api.post("/api/notify/subscriptions", input)),
    removeDevice: (id: string) => api.del(`/api/notify/subscriptions/${encodeURIComponent(id)}`),
    test: async () => NotifyTestResult.parse(await api.post("/api/notify/test", {})),
    attention: async () => AttentionSnapshot.parse(await api.get("/api/notify/attention")).items,
    seen: async (sessionId: string) => {
      await api.post("/api/notify/seen", { sessionId });
    },
  };
}
