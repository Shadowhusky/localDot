import { createConnection, type Socket } from "node:net";
import type { DoctorCheck } from "./doctor.ts";

// Major clouds answer their instance-metadata service here; a personal machine has no route to it.
const CLOUD_METADATA_HOST = "169.254.169.254";

type Connect = (options: { host: string; port: number }) => Socket;

// A fast, link-local TCP probe for a cloud metadata service. Nothing leaves the host: the address is
// link-local and no bytes are sent or read. A cloud or VPS host connects at once; a personal machine
// errors or times out. It catches the major clouds, not every metadata-less VPS. The browser's
// traffic leaves through this same host, so the host's kind reflects the egress address sites see.
export function cloudMetadataReachable(
  signal?: AbortSignal,
  timeoutMs = 400,
  connect: Connect = createConnection as Connect,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve(value);
    };
    const onAbort = () => finish(false);
    const socket = connect({ host: CLOUD_METADATA_HOST, port: 80 });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Advisory only (always ok): a datacenter egress is not a fault, but it explains the extra sign-in
// walls and CAPTCHAs Google and Cloudflare show datacenter IP addresses.
export async function egressCheck(
  reachable: (signal?: AbortSignal) => Promise<boolean> = cloudMetadataReachable,
  signal?: AbortSignal,
): Promise<DoctorCheck> {
  const datacenter = await reachable(signal).catch(() => false);
  return {
    name: "browser-egress",
    ok: true,
    detail: datacenter
      ? "This looks like a cloud or datacenter host, whose network address Google sign-in and Cloudflare challenge far more than a home network's, so the browser will meet more sign-in walls and CAPTCHAs here. Running localDot on a computer with an ordinary home connection avoids most of them. See docs/browser-environment.md."
      : "No cloud metadata service was detected, so the browser's traffic appears to leave an ordinary network.",
  };
}
