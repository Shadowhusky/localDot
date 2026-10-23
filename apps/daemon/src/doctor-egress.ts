import { createConnection, type Socket } from "node:net";
import type { DoctorCheck } from "./doctor.ts";

// Major clouds answer their instance-metadata service here; a personal machine has no route to it.
const CLOUD_METADATA_HOST = "169.254.169.254";

type Connect = (options: { host: string; port: number }) => Socket;

// A fast, link-local TCP probe for a cloud metadata service. Nothing leaves the host: the address is
// link-local and no bytes are sent or read. A cloud or VPS host connects at once; a personal machine
// errors or times out. It catches the major clouds, not every metadata-less VPS.
export function cloudMetadataReachable(
  timeoutMs = 400,
  connect: Connect = createConnection as Connect,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = connect({ host: CLOUD_METADATA_HOST, port: 80 });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

// Advisory only (always ok): a datacenter egress is not a fault, but it explains the extra sign-in
// walls and CAPTCHAs Google and Cloudflare show datacenter IPs, and points to the fix.
export async function egressCheck(
  reachable: () => Promise<boolean> = cloudMetadataReachable,
): Promise<DoctorCheck> {
  const datacenter = await reachable().catch(() => false);
  return {
    name: "browser-egress",
    ok: true,
    detail: datacenter
      ? "This looks like a cloud or datacenter host. Google sign-in and Cloudflare challenge datacenter IP addresses far more than home networks, so the browser will meet more sign-in walls and CAPTCHAs here. Run localDot where its traffic leaves a residential network, or route the browser's egress through a trusted residential proxy. See docs/browser-environment.md."
      : "No cloud metadata service was detected, so the browser's traffic appears to leave this machine's own network.",
  };
}
