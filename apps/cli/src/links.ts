import type {
  AccessLinksStatus,
  TailscaleAccess,
} from "../../../packages/protocol/src/access-links.ts";
import { terminalQr } from "../../daemon/src/terminal-qr.ts";
import type { LinkKind } from "./args.ts";
import { connect, fail, type LocalApi, LocalApiError, type LocalDot } from "./local-dot.ts";
import type { ConsoleIO } from "./runtime.ts";

export interface SignInLink {
  kind: LinkKind;
  label: string;
  url: string;
  expiresAt: number;
}

interface RemoteAccess {
  supported: boolean;
  enabled: boolean;
  state: "off" | "connecting" | "online" | "offline";
  url: string | null;
  detail: string;
}

interface LinkReport {
  links: SignInLink[];
  // Each missing kind of link, with the step that sets it up.
  next: string[];
  tailscale?: TailscaleAccess;
  remoteAccess?: RemoteAccess;
}

const CODE = /^[A-Za-z0-9_-]{43}$/;
const LINK_MS = 120_000;

function expiry(value: unknown, now: number): number {
  if (typeof value !== "number" || value <= now || value > now + LINK_MS)
    throw new Error("Invalid link expiry");
  return value;
}

function remoteAccess(value: unknown): RemoteAccess {
  const r = value as Partial<RemoteAccess> | null;
  if (
    typeof r?.supported !== "boolean" ||
    typeof r.enabled !== "boolean" ||
    !["off", "connecting", "online", "offline"].includes(r.state ?? "") ||
    typeof r.detail !== "string"
  )
    throw new Error("Invalid remote access state");
  return r as RemoteAccess;
}

function accessLinks(value: unknown): AccessLinksStatus {
  const a = value as Partial<AccessLinksStatus> | null;
  if (!Array.isArray(a?.links)) throw new Error("Invalid access links");
  return {
    links: a.links.filter((link) => typeof link?.origin === "string"),
    // A localDot started before it reported Tailscale's state.
    tailscale:
      typeof a.tailscale?.state === "string"
        ? a.tailscale
        : { state: "unavailable", message: "Restart localDot to set up Tailscale here." },
  };
}

// Old daemons don't list their addresses or offer remote access; a 404 says so.
async function optional<T>(read: Promise<unknown>, parse: (value: unknown) => T) {
  try {
    return parse(await read);
  } catch (error) {
    if (error instanceof LocalApiError && error.status === 404) return undefined;
    throw error;
  }
}

function tailscaleNext(l: LocalDot, tailscale: TailscaleAccess | undefined): string {
  if (tailscale?.state === "ready-to-enable")
    return `Tailscale is ready, but isn't sharing ${l.name} yet. Turn it on with: localdot tailscale on${l.dotFlag}`;
  if (tailscale) return `No network link: ${tailscale.message}`;
  return `No network link: set LOCALDOT_PUBLIC_ORIGIN to an HTTPS address that reaches this computer, such as Tailscale Serve.`;
}

function remoteNext(l: LocalDot, remote: RemoteAccess | undefined): string {
  if (!remote) return `This ${l.name} has no remote access. Update localDot to use it.`;
  if (!remote.supported) return `No remote link: ${remote.detail}`;
  if (!remote.enabled)
    return `Remote access is off. To open ${l.name} from anywhere through the localDot relay: localdot remote on${l.dotFlag}`;
  return `Remote access is on but ${remote.state === "connecting" ? "still connecting" : "offline"}, so there's no remote link yet. Try again in a moment; localdot remote status${l.dotFlag} shows its state.`;
}

// Fresh one-use links: each gets its own code, so opening one doesn't spend the others.
export async function signInLinks(l: LocalDot, api: LocalApi, only?: LinkKind) {
  const report: LinkReport = { links: [], next: [] };
  const wanted = (kind: LinkKind) => !only || only === kind;
  const code = async () => {
    const issued = await api<{ code?: unknown; expiresAt?: unknown }>("POST", "/api/install-code");
    if (typeof issued?.code !== "string" || !CODE.test(issued.code))
      throw new Error("Invalid sign-in code");
    return { code: issued.code, expiresAt: expiry(issued.expiresAt, l.now()) };
  };
  if (wanted("local")) {
    const issued = await code();
    report.links.push({
      kind: "local",
      label: "This computer",
      url: `http://127.0.0.1:${l.port}/#code=${issued.code}`,
      expiresAt: issued.expiresAt,
    });
  }
  if (wanted("network")) {
    const access = await optional(api("GET", "/api/access-links"), accessLinks);
    report.tailscale = access?.tailscale;
    const addresses = access
      ? access.links.filter((address) => address.origin.startsWith("https://"))
      : l.publicOrigins.map((url) => ({ origin: url.origin, label: "Remote address" }));
    if (access?.tailscale.state === "served" && access.tailscale.origin)
      addresses.unshift({ origin: access.tailscale.origin, label: "Tailscale" });
    const seen = new Set<string>();
    for (const address of addresses) {
      if (seen.has(address.origin) || !URL.canParse(address.origin)) continue;
      seen.add(address.origin);
      const issued = await code();
      report.links.push({
        kind: "network",
        label: address.label,
        url: `${new URL(address.origin).origin}/#code=${issued.code}`,
        expiresAt: issued.expiresAt,
      });
    }
    if (!seen.size) report.next.push(tailscaleNext(l, access?.tailscale));
  }
  if (wanted("remote")) {
    const remote = await optional(api("GET", "/api/remote-access"), remoteAccess);
    report.remoteAccess = remote;
    if (remote?.enabled && remote.state === "online") {
      const issued = await api<{ url?: unknown; expiresAt?: unknown }>(
        "POST",
        "/api/remote-access/link",
      );
      if (typeof issued?.url !== "string" || !issued.url.startsWith("https://"))
        throw new Error("Invalid remote link");
      report.links.push({
        kind: "remote",
        label: "Remote access",
        url: issued.url,
        expiresAt: expiry(issued.expiresAt, l.now()),
      });
    } else report.next.push(remoteNext(l, remote));
  }
  return report;
}

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export async function runLink(
  l: LocalDot,
  io: ConsoleIO,
  options: { only?: LinkKind; qr: boolean; json: boolean },
): Promise<number> {
  const report = await signInLinks(l, await connect(l), options.only);
  const found = report.links.length > 0;
  if (options.json) {
    io.out(
      JSON.stringify({
        links: report.links,
        next: report.next,
        tailscale: report.tailscale ?? null,
        remoteAccess: report.remoteAccess ?? null,
      }),
    );
    return found ? 0 : 1;
  }
  if (found) {
    const until = Math.min(...report.links.map((link) => link.expiresAt));
    io.out(
      `Each link signs in once and expires within a minute (by ${clock(until)}). Run localdot link again for fresh ones.`,
    );
    const width = Math.max(...report.links.map((link) => link.label.length));
    for (const link of report.links) io.out(`  ${link.label.padEnd(width)}  ${link.url}`);
  }
  for (const step of report.next) {
    if (found) io.out(step);
    else io.err(step);
  }
  if (!options.qr) return found ? 0 : 1;
  // A phone can't open this computer's own address.
  const phone =
    report.links.find((link) => link.kind === "remote") ??
    report.links.find((link) => link.kind === "network");
  const lines = phone && terminalQr(phone.url);
  if (!phone || !lines) {
    io.err(
      `No QR code: a phone needs remote access (localdot remote on${l.dotFlag}) or Tailscale (localdot tailscale on${l.dotFlag}).`,
    );
    return 1;
  }
  io.out(
    [
      "",
      ...lines,
      "",
      `Scan it with your phone (${phone.label}). It works once, within a minute.`,
    ].join("\n"),
  );
  return 0;
}

function describeRemote(l: LocalDot, remote: RemoteAccess): string {
  if (!remote.supported) return `Remote access isn't available: ${remote.detail}`;
  if (!remote.enabled)
    return `Remote access is off. Turn it on with: localdot remote on${l.dotFlag}`;
  const at = remote.url ? ` at ${remote.url}` : "";
  if (remote.state === "online")
    return `Remote access is on and connected${at}. Connections pass through the localDot relay, and this computer must stay on. For a sign-in link: localdot link remote --qr${l.dotFlag}`;
  return `Remote access is on and ${remote.state === "connecting" ? "connecting" : "offline"}${at}. Check again with: localdot remote status${l.dotFlag}`;
}

export async function runRemote(
  l: LocalDot,
  io: ConsoleIO,
  options: { operation: "on" | "off" | "status"; json: boolean },
): Promise<number> {
  const api = await connect(l);
  const read = async () =>
    (await optional(api("GET", "/api/remote-access"), remoteAccess)) ??
    fail(`This ${l.name} has no remote access. Update localDot to use it.`);
  let remote = await read();
  if (options.operation !== "status") {
    if (!remote.supported) fail(`Remote access isn't available: ${remote.detail}`);
    try {
      remote = remoteAccess(
        await api("PUT", "/api/remote-access", { enabled: options.operation === "on" }),
      );
    } catch (error) {
      if (error instanceof LocalApiError)
        fail(`Remote access couldn't be changed: ${error.message}`);
      throw error;
    }
    if (options.operation === "on") io.out("Connecting to the localDot relay…");
    const deadline = l.now() + 20_000;
    while (options.operation === "on" && remote.state !== "online" && l.now() < deadline) {
      await l.sleep(1000);
      remote = await read();
    }
  }
  if (options.json) io.out(JSON.stringify(remote));
  else if (options.operation === "off")
    io.out("Remote access is off. Links shared through the relay stop working too.");
  else io.out(describeRemote(l, remote));
  return 0;
}

const STANDING: Record<TailscaleAccess["state"], string> = {
  "not-installed": "not installed",
  "not-running": "not running",
  "needs-login": "signed out",
  "needs-approval": "waiting for you to allow HTTPS",
  "ready-to-enable": "off",
  served: "on",
  unavailable: "unavailable",
};

export function describeTailscale(tailscale: TailscaleAccess): string {
  return tailscale.state === "served" && tailscale.origin
    ? `on at ${tailscale.origin}`
    : STANDING[tailscale.state];
}

export async function runTailscale(
  l: LocalDot,
  io: ConsoleIO,
  operation: "on" | "status",
): Promise<number> {
  const api = await connect(l);
  const read = async (fresh: boolean) =>
    (await optional(api("GET", `/api/access-links${fresh ? "?fresh=1" : ""}`), accessLinks)) ??
    fail(`This ${l.name} can't set up Tailscale. Update localDot to use it.`);
  let access = await read(true);
  if (operation === "on" && access.tailscale.state !== "served") {
    io.out("Turning on Tailscale sharing…");
    try {
      // Tailscale may take a while to answer, or wait for HTTPS to be allowed.
      access = accessLinks(await api("POST", "/api/access-links/tailscale", undefined, 100_000));
    } catch (error) {
      if (error instanceof LocalApiError) fail(error.message);
      throw error;
    }
    if (access.tailscale.state === "needs-approval" && access.tailscale.approvalUrl) {
      io.out(`Allow HTTPS for this computer in Tailscale: ${access.tailscale.approvalUrl}`);
      io.out("Waiting for you to allow it…");
      const deadline = l.now() + 120_000;
      while (access.tailscale.state === "needs-approval" && l.now() < deadline) {
        await l.sleep(2000);
        access = await read(false);
      }
    }
  }
  const tailscale = access.tailscale;
  if (tailscale.state === "served") {
    io.out(
      `Tailscale is sharing ${l.name} at ${tailscale.origin}. For a sign-in link: localdot link network${l.dotFlag}`,
    );
    return 0;
  }
  io.out(`Tailscale is ${describeTailscale(tailscale)}. ${tailscale.message}`);
  if (tailscale.operatorHint) io.out(`  ${tailscale.operatorHint}`);
  if (operation === "status" && tailscale.state === "ready-to-enable")
    io.out(`Turn it on with: localdot tailscale on${l.dotFlag}`);
  return operation === "on" ? 1 : 0;
}
