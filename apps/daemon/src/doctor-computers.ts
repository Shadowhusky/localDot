import { createHash } from "node:crypto";
import { readContainerInventory } from "../../cli/src/install/container-containment.ts";
import type { DockerClient } from "./cells/docker.ts";
import type { DoctorCheck } from "./doctor.ts";

const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const states = [
  "created",
  "running",
  "paused",
  "restarting",
  "removing",
  "exited",
  "dead",
] as const;
type Inventory = Awaited<ReturnType<typeof readContainerInventory>>;

// Read only. Stopped containers do not prove that a host-side model process has exited.
export async function computerContainerCheck(
  docker: Pick<DockerClient, "request">,
  home: string,
  inventory: () => Promise<Inventory> = () => readContainerInventory(home),
): Promise<DoctorCheck> {
  const name = "computer-containers";
  try {
    const saved = await inventory();
    if (saved.invalid) throw new Error("unreadable records");
    const records = new Map(saved.records.map((r) => [r.id, r]));
    const homeId = createHash("sha256").update(home).digest("hex").slice(0, 16);
    const rows = await docker.request<unknown>({
      method: "GET",
      path: "/containers/json",
      query: { all: "true", filters: JSON.stringify({ label: ["localdot.role"] }) },
      timeoutMs: 5000,
    });
    if (!Array.isArray(rows) || rows.length > 4096) throw new Error("invalid container list");
    const counts = new Map<string, number>();
    const seen = new Set<string>();
    const members = new Map<string, Set<string>>();
    const activeMembers = new Map<string, number>();
    for (const row of rows) {
      if (!object(row) || !object(row.Labels)) throw new Error("invalid container status");
      const labels = row.Labels;
      const record = records.get(String(labels["localdot.cell"] ?? ""));
      if (!record && labels["localdot.home"] !== homeId) continue;
      const role = labels["localdot.role"];
      if (
        typeof row.Id !== "string" ||
        !/^[a-f0-9]{64}$/.test(row.Id) ||
        seen.has(row.Id) ||
        typeof row.State !== "string" ||
        !states.includes(row.State as (typeof states)[number])
      )
        throw new Error("unknown container status");
      if (record) {
        if (role !== "gate" && role !== record.kind) throw new Error("unknown computer member");
        const expected =
          record.kind === "desktop"
            ? record.ownership?.[role === "gate" ? "gate" : "desktop"]
            : record.ownership?.[role === "gate" ? "gate" : "browser"];
        // A runtime update can change ownership while doctor reads. Retry, never infer absence.
        if (expected && row.Id !== expected) throw new Error("computer changed");
        const roles = members.get(record.id) ?? new Set<string>();
        if (roles.has(String(role))) throw new Error("duplicate computer member");
        roles.add(String(role));
        members.set(record.id, roles);
        if (row.State === "running" || row.State === "paused")
          activeMembers.set(record.id, (activeMembers.get(record.id) ?? 0) + 1);
      } else if (role !== "brain" && role !== "brain-gate") throw new Error("unknown task member");
      seen.add(row.Id);
      counts.set(row.State, (counts.get(row.State) ?? 0) + 1);
    }
    const summary = states
      .filter((s) => counts.has(s))
      .map((s) => `${counts.get(s)} ${s === "exited" ? "stopped" : s}`)
      .join(", ");
    const missing = [...records.keys()].reduce((n, id) => n + 2 - (members.get(id)?.size ?? 0), 0);
    const partial = [...members.values()].some((roles) => roles.size !== 2);
    const mixed = [...activeMembers.values()].some((count) => count !== 2);
    const unstable =
      partial || mixed || ["restarting", "removing", "dead"].some((s) => counts.has(s));
    return {
      name,
      ok: !unstable,
      ...(unstable ? { pendingAction: "recover-computer" as const } : {}),
      detail: `${summary ? `localDot: ${summary}.` : "No localDot containers are running or present."}${missing ? ` ${missing} saved computer containers are absent; saved data may still be present.` : ""} ${
        unstable
          ? "If no computer update is in progress, run localdot doctor --fix, then open the app to recover the computer."
          : counts.has("running") || counts.has("paused")
            ? "Native task cleanup is checked separately."
            : "The computer is off. Open the app to turn it on; if recovery is blocked, run localdot doctor --fix."
      }`,
    };
  } catch {
    return {
      name,
      ok: false,
      pendingAction: "recover-computer",
      detail:
        "localDot container status could not be verified. Docker may be unavailable, records may be unreadable, or a computer may be changing. Rerun localdot doctor; this does not mean the containers are stopped.",
    };
  }
}
