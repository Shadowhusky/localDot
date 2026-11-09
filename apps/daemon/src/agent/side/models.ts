import { BlockList, isIP } from "node:net";
import type { ModelOptions } from "@localdot/protocol";
import { providerById } from "@localdot/providers";
import type { ResolvedRole } from "../bindings.ts";
import type { SideModel } from "./agent.ts";

export type SideSelection =
  | { readonly kind: "api"; readonly roles: readonly ResolvedRole[] }
  | {
      readonly kind: "claude-code";
      readonly fast?: unknown;
      readonly quick: readonly { readonly model: string; readonly options?: ModelOptions }[];
    }
  | { readonly kind: "chatgpt" }
  | { readonly kind: "none" };
export interface SideModelDeps {
  api(role: ResolvedRole, side: SideModel["role"]): SideModel;
  plan?(quick: { model: string; options?: ModelOptions }, side: SideModel["role"]): SideModel;
  // The address a custom endpoint's key is bound to; undefined when it can't be read.
  endpointOf?(role: ResolvedRole): string | undefined;
}

// Loopback and private ranges: an address on this Mac or the user's own network.
const NEARBY = new BlockList();
NEARBY.addSubnet("127.0.0.0", 8, "ipv4");
NEARBY.addSubnet("10.0.0.0", 8, "ipv4");
NEARBY.addSubnet("172.16.0.0", 12, "ipv4");
NEARBY.addSubnet("192.168.0.0", 16, "ipv4");
NEARBY.addAddress("::1", "ipv6");
NEARBY.addSubnet("fc00::", 7, "ipv6");

export function nearby(address: string): boolean {
  let host: string;
  try {
    host = new URL(address).hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "");
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  // BlockList reads an IPv4 address written as IPv6 (::ffff:7f00:1) as that IPv4 address.
  const family = isIP(host);
  return family === 4
    ? NEARBY.check(host, "ipv4")
    : family === 6
      ? NEARBY.check(host, "ipv6")
      : false;
}

// Who answers: the models the user chose for this task, as its next message would run on them,
// and no other. The fast model goes first, then the main one, then a local one: the user chose to
// show the task to each. Any other model, even one set up in Settings, would take the task's record
// to a provider it never went to, so a task none of its own can answer is told why instead. A task
// whose main model is local stays on this Mac: its models in the cloud are left out. Local is a
// local server, or a custom endpoint at an address on this Mac or the user's network; a custom main
// model whose address can't be read counts as local, a custom fast model as the cloud. The ChatGPT
// plan's one Codex process is the task's.
export function sideModels(selection: SideSelection, deps: SideModelDeps): SideModel[] {
  if (selection.kind === "api") {
    const local = (role: ResolvedRole, unread: boolean) => {
      const provider = providerById(role.providerId);
      if (provider?.local) return true;
      if (!provider?.custom) return false;
      const address = deps.endpointOf?.(role);
      return address === undefined || !URL.canParse(address) ? unread : nearby(address);
    };
    const main = selection.roles.find((role) => role.role === "main");
    const ours =
      main && local(main, true) ? (role: ResolvedRole) => local(role, false) : () => true;
    const fast = selection.roles.find((role) => role.role === "fast" && ours(role));
    return [
      ...(fast ? [deps.api(fast, "fast")] : []),
      ...(main ? [deps.api(main, "main")] : []),
      ...selection.roles
        .filter((role) => role.role === "local" && ours(role))
        .map((role) => deps.api(role, "other")),
    ];
  }
  if (selection.kind !== "claude-code" || !deps.plan) return [];
  const plan = deps.plan;
  return selection.quick.map((quick, at) =>
    plan(quick, selection.fast && at === 0 ? "fast" : "main"),
  );
}
