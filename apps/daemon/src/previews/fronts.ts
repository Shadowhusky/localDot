import type { TailscaleAccess } from "@localdot/protocol";

// Where previews can open: HTTPS on the owner's tailnet only, never this Mac's localhost, which
// shares cookies with every other local server and reaches the LAN directly.
export interface PreviewFronts {
  // HTTPS fronts set up by address (LOCALDOT_PUBLIC_ORIGIN): each listens on the preview ports too,
  // so Tailscale Serve, which would take the same ports on the same address, isn't used beside them.
  direct: string[];
  // This computer's tailnet name, while Tailscale Serve shares localDot.
  served?: string;
  // What to do when there is neither.
  problem: string;
}

export interface PreviewFront {
  hostname: string;
  // The preview port needs a Tailscale Serve entry of its own.
  serve: boolean;
}

// 100.64.0.0/10 and Tailscale's fd7a:115c:a1e0::/48.
export function isTailnetAddress(hostname: string): boolean {
  const v4 = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(hostname);
  if (v4) return Number(v4[1]) >= 64 && Number(v4[1]) <= 127;
  return /^\[fd7a:115c:a1e0:/i.test(hostname);
}

export function previewFronts(
  configured: readonly string[],
  tailscale?: TailscaleAccess,
): PreviewFronts {
  const direct = [
    ...new Set(configured.map((origin) => new URL(origin).hostname).filter(isTailnetAddress)),
  ];
  const served =
    tailscale?.state === "served" && tailscale.origin
      ? new URL(tailscale.origin).hostname
      : undefined;
  return {
    direct,
    ...(served ? { served } : {}),
    problem:
      tailscale?.state === "ready-to-enable"
        ? "Previews open over Tailscale, on this Mac and your phone alike. Turn on Tailscale in Settings › Your computer, then try again."
        : `Previews open over Tailscale, on this Mac and your phone alike. ${tailscale?.message ?? "Set up Tailscale in Settings › Your computer, then try again."}`,
  };
}

// The front a device that asked through `requestHost` opens a preview on: the address it came in
// on when that is a front, so the same link works where it asked from.
export function frontFor(
  fronts: PreviewFronts,
  requestHost: string | undefined,
): PreviewFront | undefined {
  const asked =
    requestHost && URL.canParse(`https://${requestHost}`)
      ? new URL(`https://${requestHost}`).hostname
      : "";
  if (fronts.direct.length)
    return {
      hostname: fronts.direct.includes(asked) ? asked : (fronts.direct[0] as string),
      serve: false,
    };
  return fronts.served ? { hostname: fronts.served, serve: true } : undefined;
}

// Every name a preview on `port` may be reached by.
export function frontHosts(fronts: PreviewFronts, port: number): Set<string> {
  return new Set(
    [...fronts.direct, ...(fronts.served ? [fronts.served] : [])].map((name) =>
      `${name}:${port}`.toLowerCase(),
    ),
  );
}
