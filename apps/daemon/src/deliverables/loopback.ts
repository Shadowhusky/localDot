import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
// Present when a front (Tailscale Serve or any proxy) relayed the request onto loopback.
const RELAYED = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "via",
  "tailscale-user-login",
  "tailscale-user-name",
];

// A request made by a browser on this Mac to the daemon's own loopback address. A front relays over
// loopback too, so the socket address alone proves nothing: the Host and the Origin must name the
// loopback daemon and no relay header may be present.
export function isLoopbackRequest(c: Context, port: number): boolean {
  let address: string | undefined;
  try {
    address = getConnInfo(c).remote.address;
  } catch {
    return false;
  }
  if (!address || !LOOPBACK_ADDRESSES.has(address)) return false;
  const local = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!local.includes(c.req.header("host") ?? "")) return false;
  if (!local.includes(new URL(c.req.url).host)) return false;
  const origin = c.req.header("origin");
  if (!origin || !local.some((host) => origin === `http://${host}`)) return false;
  const site = c.req.header("sec-fetch-site");
  if (site !== undefined && site !== "same-origin") return false;
  return RELAYED.every((name) => c.req.header(name) === undefined);
}
