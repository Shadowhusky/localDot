import { execFile } from "node:child_process";
import { promises as dns } from "node:dns";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Agent, request } from "node:http";
import { connect, isIP } from "node:net";
import type { SelfTestCheck, SelfTestReport } from "@localdot/protocol";

// The cell's boot self-test (spec, trust rule 1 and success criterion 5): the cell reaches
// nothing but its gate, and through the gate exactly its own keyd listener, which wants its token.
// Every check fails closed: a check that cannot reach a conclusion fails.

type CheckKind = SelfTestCheck["kind"];

export interface ProxyReply {
  status: number;
  body: string;
}

// The network and file primitives, injected so the checks can be tested without a cell.
export interface Probes {
  readFile(path: string): Promise<string | undefined>;
  // "connected", or why not (an errno code or "timeout").
  tcpConnect(host: string, port: number, timeoutMs: number): Promise<string>;
  // The addresses a name resolves to through the cell's resolver, or why not.
  resolve(name: string, timeoutMs: number): Promise<string[] | string>;
  proxyGet(
    proxy: { host: string; port: number },
    url: string,
    authorization: string | undefined,
    timeoutMs: number,
  ): Promise<ProxyReply | string>;
  run(
    command: string,
    args: string[],
    timeoutMs: number,
  ): Promise<{ code: number; stdout: string }>;
}

export interface SelfTestConfig {
  cellId: string | undefined;
  gate: { host: string; port: number } | undefined;
  forwarder: { host: string; port: number };
  tokenFile: string;
  caFile: string;
  systemBundle: string;
  nssDb: string;
  timeoutMs: number;
}

interface CheckConfig extends SelfTestConfig {
  remainingMs(): number;
}

// Addresses only a route out could reach: a public anycast resolver on both families, and Docker
// Desktop's host address, where LM Studio (1234) and Ollama (11434) would answer.
const PUBLIC_V4 = { host: "1.1.1.1", port: 443 };
const PUBLIC_V6 = { host: "2606:4700:4700::1111", port: 443 };
const PUBLIC_NAME = "example.com";
const HOST_NAMES = ["host.docker.internal", "gateway.docker.internal"];
const HOST_ADDRESS = "192.168.65.254";
const HOST_PORTS = [1234, 11434];
// The internal network's gateway slot (its first host address) on two ports: with isolated
// gateway mode nothing holds that address, so a connection is unreachable or times out; where an
// engine ignores the mode, Docker Desktop's VM holds it and connects or refuses (trust rule 1).
const GATEWAY_PORTS = [53, 80];
const HEALTH_URL = "http://keyd.ldot/health";
const UNREACHABLE = new Set(["ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT", "timeout"]);
const NO_DNS = new Set([
  "ENOTFOUND",
  "ENODATA",
  "ESERVFAIL",
  "EREFUSED",
  "ECONNREFUSED",
  "ETIMEOUT",
  "timeout",
]);

export async function runSelfTest(cfg: SelfTestConfig, probes: Probes): Promise<SelfTestReport> {
  const started = performance.now();
  const checks = await Promise.all([
    bounded("route", "isolation", cfg, () => noDefaultRoute(probes)),
    bounded("direct-ipv4", "isolation", cfg, (c) => noDirect("direct-ipv4", PUBLIC_V4, c, probes)),
    bounded("direct-ipv6", "isolation", cfg, (c) => noDirect("direct-ipv6", PUBLIC_V6, c, probes)),
    bounded("dns", "isolation", cfg, (c) => noDns(c, probes)),
    bounded("host", "isolation", cfg, (c) => noHost(c, probes)),
    bounded("gateway", "isolation", cfg, (c) => noGateway(c, probes)),
    bounded("keyd-token", "keyd", cfg, (c) => keydWantsToken(c, probes)),
    bounded("keyd", "keyd", cfg, (c) => keydAnswers(c, probes)),
    bounded("forwarder", "keyd", cfg, (c) => forwarderAnswers(c, probes)),
    bounded("ca-system", "trust", cfg, (c) => caInSystemStore(c, probes)),
    bounded("ca-nss", "trust", cfg, (c) => caInNss(c, probes)),
  ]);
  return { ok: checks.every((c) => c.ok), checks, ms: performance.now() - started };
}

async function bounded(
  id: string,
  kind: CheckKind,
  cfg: SelfTestConfig,
  run: (cfg: CheckConfig) => Promise<SelfTestCheck>,
): Promise<SelfTestCheck> {
  // Give primitives a little room to report a network timeout before the check's hard deadline.
  // Sequential operations share this budget; they cannot each start a fresh two seconds.
  const deadline = performance.now() + cfg.timeoutMs - Math.min(20, cfg.timeoutMs / 4);
  const remainingMs = () => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) throw new Error("check deadline");
    return remaining;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => run({ ...cfg, remainingMs })),
      new Promise<SelfTestCheck>((resolve) => {
        timer = setTimeout(() => resolve(fail(id, kind, "check deadline exceeded")), cfg.timeoutMs);
      }),
    ]);
  } catch {
    // Exceptions may contain paths, subprocess output or credentials. Keep the result static.
    return fail(id, kind, "probe failed; result inconclusive");
  } finally {
    clearTimeout(timer);
  }
}

const pass = (id: string, kind: CheckKind, detail: string): SelfTestCheck => ({
  id,
  kind,
  ok: true,
  detail,
});
const fail = (id: string, kind: CheckKind, detail: string): SelfTestCheck => ({
  id,
  kind,
  ok: false,
  detail,
});

async function noDefaultRoute(probes: Probes): Promise<SelfTestCheck> {
  const [v4Text, v6] = await Promise.all([
    probes.readFile("/proc/net/route"),
    probes.readFile("/proc/net/ipv6_route"),
  ]);
  const v4 = ipv4Routes(v4Text);
  if (!v4) return fail("route", "isolation", "unreadable or malformed IPv4 routes");
  if (v4.some((r) => r.destination === 0 && r.mask === 0))
    return fail("route", "isolation", "an IPv4 default route exists");
  if (v6 === undefined) return fail("route", "isolation", "cannot read IPv6 routes");
  for (const line of v6.split("\n").filter((s) => s.trim())) {
    const fields = line.trim().split(/\s+/);
    if (
      fields.length !== 10 ||
      ![0, 2, 4].every((i) => /^[a-f\d]{32}$/i.test(fields[i] ?? "")) ||
      ![1, 3].every(
        (i) => /^[a-f\d]{2}$/i.test(fields[i] ?? "") && Number.parseInt(fields[i] ?? "", 16) <= 128,
      ) ||
      ![5, 6, 7, 8].every((i) => /^[a-f\d]{8}$/i.test(fields[i] ?? ""))
    )
      return fail("route", "isolation", "malformed IPv6 routes");
    if (fields[0] === "0".repeat(32) && fields[1] === "00" && fields[9] !== "lo")
      return fail("route", "isolation", "an IPv6 default route exists");
  }
  return pass("route", "isolation", "no default route");
}

async function noDirect(
  id: string,
  target: { host: string; port: number },
  cfg: CheckConfig,
  probes: Probes,
): Promise<SelfTestCheck> {
  const result = await probes.tcpConnect(target.host, target.port, cfg.remainingMs());
  return UNREACHABLE.has(result)
    ? pass(id, "isolation", `${target.host}:${target.port}: ${result}`)
    : fail(id, "isolation", `${target.host}:${target.port} answered or the probe was inconclusive`);
}

async function noDns(cfg: CheckConfig, probes: Probes): Promise<SelfTestCheck> {
  const result = await probes.resolve(PUBLIC_NAME, cfg.remainingMs());
  return typeof result === "string" && NO_DNS.has(result)
    ? pass("dns", "isolation", `${PUBLIC_NAME}: ${result}`)
    : fail("dns", "isolation", `${PUBLIC_NAME} resolved or the probe was inconclusive`);
}

async function noHost(cfg: CheckConfig, probes: Probes): Promise<SelfTestCheck> {
  const unreachable = async (host: string) => {
    if (!isIP(host)) return false;
    const outcomes = await Promise.all(
      HOST_PORTS.map((port) => probes.tcpConnect(host, port, cfg.remainingMs())),
    );
    return outcomes.every((r) => UNREACHABLE.has(r));
  };
  const results = await Promise.all([
    unreachable(HOST_ADDRESS),
    ...HOST_NAMES.map(async (name) => {
      const found = await probes.resolve(name, cfg.remainingMs());
      if (typeof found === "string") return NO_DNS.has(found);
      if (found.length === 0 || found.length > 32) return false;
      return (await Promise.all([...new Set(found)].map(unreachable))).every(Boolean);
    }),
  ]);
  return results.every(Boolean)
    ? pass("host", "isolation", "host addresses unreachable")
    : fail("host", "isolation", "a host address answered or the probe was inconclusive");
}

async function noGateway(cfg: CheckConfig, probes: Probes): Promise<SelfTestCheck> {
  const routes = await probes.readFile("/proc/net/route");
  if (routes === undefined) return fail("gateway", "isolation", "cannot read /proc/net/route");
  const slot = gatewaySlot(routes, cfg.gate?.host);
  if (!slot) return fail("gateway", "isolation", "no cell network in /proc/net/route");
  const results = await Promise.all(
    GATEWAY_PORTS.map((port) => probes.tcpConnect(slot, port, cfg.remainingMs())),
  );
  return results.every((r) => UNREACHABLE.has(r))
    ? pass("gateway", "isolation", `${slot}: ${results.join(", ")}`)
    : fail("gateway", "isolation", "the gateway answered or the probe was inconclusive");
}

// The first host address of the cell's network: the route that is neither the default one nor
// loopback's. /proc/net/route prints addresses as little-endian hex.
function gatewaySlot(text: string, gate: string | undefined): string | undefined {
  const routes = ipv4Routes(text);
  if (!routes) return undefined;
  const gateIp =
    gate && isIP(gate) === 4
      ? gate.split(".").reduce((ip, part) => ip * 256 + Number(part), 0)
      : undefined;
  const cellRoutes = routes.filter(
    (r) =>
      r.iface !== "lo" &&
      r.gateway === 0 &&
      (r.flags & 1) !== 0 &&
      r.mask !== 0 &&
      r.mask < 0xfffffffe &&
      (gateIp === undefined || (gateIp & r.mask) >>> 0 === r.destination),
  );
  if (cellRoutes.length !== 1) return undefined;
  const host = (cellRoutes[0]?.destination ?? 0) + 1;
  return [host >>> 24, (host >>> 16) & 0xff, (host >>> 8) & 0xff, host & 0xff].join(".");
}

interface Ipv4Route {
  iface: string;
  destination: number;
  gateway: number;
  flags: number;
  mask: number;
}
function ipv4Routes(text: string | undefined): Ipv4Route[] | undefined {
  if (text === undefined) return undefined;
  const [header, ...lines] = text.trim().split("\n");
  const columns = header?.trim().split(/\s+/) ?? [];
  if (
    ![8, 11].includes(columns.length) ||
    columns.slice(0, 8).join(" ") !== "Iface Destination Gateway Flags RefCnt Use Metric Mask"
  )
    return undefined;
  const decode = (hex: string) => Buffer.from(hex, "hex").readUInt32LE();
  const result: Ipv4Route[] = [];
  for (const line of lines.filter((s) => s.trim())) {
    const fields = line.trim().split(/\s+/);
    if (
      fields.length !== columns.length ||
      ![1, 2, 7].every((i) => /^[a-f\d]{8}$/i.test(fields[i] ?? "")) ||
      !/^[a-f\d]{4,8}$/i.test(fields[3] ?? "") ||
      ![4, 5, 6].every((i) => /^\d+$/.test(fields[i] ?? ""))
    )
      return undefined;
    const destination = decode(fields[1] ?? "");
    const mask = decode(fields[7] ?? "");
    const hostMask = ~mask >>> 0;
    if ((hostMask & (hostMask + 1)) !== 0 || (destination & mask) >>> 0 !== destination)
      return undefined;
    result.push({
      iface: fields[0] ?? "",
      destination,
      gateway: decode(fields[2] ?? ""),
      flags: Number.parseInt(fields[3] ?? "", 16),
      mask,
    });
  }
  return result;
}

async function keydWantsToken(cfg: CheckConfig, probes: Probes): Promise<SelfTestCheck> {
  if (!cfg.gate) return fail("keyd-token", "keyd", "no gate address (LOCALDOT_GATE_ADDR)");
  const reply = await probes.proxyGet(cfg.gate, HEALTH_URL, undefined, cfg.remainingMs());
  if (typeof reply === "string")
    return fail("keyd-token", "keyd", "no conclusive reply from the gate");
  return reply.status === 407
    ? pass("keyd-token", "keyd", "keyd refuses a request without the cell's token")
    : fail("keyd-token", "keyd", `keyd answered ${reply.status} without the cell's token`);
}

async function keydAnswers(cfg: CheckConfig, probes: Probes): Promise<SelfTestCheck> {
  if (!cfg.gate) return fail("keyd", "keyd", "no gate address (LOCALDOT_GATE_ADDR)");
  const token = (await probes.readFile(cfg.tokenFile))?.trim();
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
    return fail("keyd", "keyd", "no valid proxy token");
  const basic = `Basic ${Buffer.from(`cell:${token}`).toString("base64")}`;
  return healthIs(
    "keyd",
    cfg,
    await probes.proxyGet(cfg.gate, HEALTH_URL, basic, cfg.remainingMs()),
  );
}

async function forwarderAnswers(cfg: CheckConfig, probes: Probes): Promise<SelfTestCheck> {
  return healthIs(
    "forwarder",
    cfg,
    await probes.proxyGet(cfg.forwarder, HEALTH_URL, undefined, cfg.remainingMs()),
  );
}

function healthIs(id: string, cfg: SelfTestConfig, reply: ProxyReply | string): SelfTestCheck {
  if (typeof reply === "string") return fail(id, "keyd", "no conclusive health reply");
  if (reply.status !== 200) return fail(id, "keyd", `keyd.ldot answered ${reply.status}`);
  let body: unknown;
  try {
    body = JSON.parse(reply.body);
  } catch {
    return fail(id, "keyd", "keyd.ldot answered something other than JSON");
  }
  if (!cfg.cellId) return fail(id, "keyd", "no cell id (LOCALDOT_CELL_ID)");
  return typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    "ok" in body &&
    body.ok === true &&
    "cell" in body &&
    body.cell === cfg.cellId
    ? pass(id, "keyd", `keyd knows this cell as ${cfg.cellId}`)
    : fail(id, "keyd", "keyd did not confirm this cell's health and identity");
}

// The system store holds the cell's CA as a plain anchor, the one form every client reads
// (OpenSSL, GnuTLS, Go, rustls and Java's hook). What it may vouch for lives in the certificate:
// serverAuth only, and only the hosts keyd intercepts for this cell (Part 4a's cellca, P4b-C4).
// OpenSSL's per-purpose TRUSTED CERTIFICATE form is skipped by every other client.
async function caInSystemStore(cfg: SelfTestConfig, probes: Probes): Promise<SelfTestCheck> {
  const ca = derOf(await probes.readFile(cfg.caFile));
  if (!ca) return fail("ca-system", "trust", `no cell CA in ${cfg.caFile}`);
  const bundle = await probes.readFile(cfg.systemBundle);
  if (bundle === undefined) return fail("ca-system", "trust", `cannot read ${cfg.systemBundle}`);
  return pemBlocks(bundle).some((b) => b.label === "CERTIFICATE" && b.der.equals(ca))
    ? pass("ca-system", "trust", "the system store trusts the cell's CA")
    : fail("ca-system", "trust", `the cell's CA is not a plain anchor in ${cfg.systemBundle}`);
}

async function caInNss(cfg: CheckConfig, probes: Probes): Promise<SelfTestCheck> {
  const ca = derOf(await probes.readFile(cfg.caFile));
  if (!ca) return fail("ca-nss", "trust", `no cell CA in ${cfg.caFile}`);
  const db = `sql:${cfg.nssDb}`;
  const list = await probes.run("certutil", ["-d", db, "-L"], cfg.remainingMs());
  const entries = list.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^localdot-cell(?:\s|$)/.test(line));
  const trusted = entries.length === 1 && /^localdot-cell\s+C,,$/.test(entries[0] ?? "");
  if (list.code !== 0 || !trusted)
    return fail("ca-nss", "trust", "Chromium's NSS database does not trust localdot-cell as C,,");
  const exported = await probes.run(
    "certutil",
    ["-d", db, "-L", "-n", "localdot-cell", "-a"],
    cfg.remainingMs(),
  );
  return exported.code === 0 && derOf(exported.stdout)?.equals(ca)
    ? pass("ca-nss", "trust", "Chromium trusts the cell's CA")
    : fail("ca-nss", "trust", "Chromium's localdot-cell is another CA");
}

function pemBlocks(text: string): { label: string; der: Buffer }[] {
  return [...text.matchAll(/-----BEGIN ([A-Z0-9 ]+)-----([^-]*)-----END \1-----/g)].flatMap((m) => {
    const encoded = (m[2] ?? "").replace(/\s+/g, "");
    const der = Buffer.from(encoded, "base64");
    return der.length > 0 && der.toString("base64") === encoded ? [{ label: m[1] ?? "", der }] : [];
  });
}

function derOf(pem: string | undefined): Buffer | undefined {
  const certificates = pemBlocks(pem ?? "").filter((b) => b.label === "CERTIFICATE");
  return certificates.length === 1 ? certificates[0]?.der : undefined;
}

// The real primitives. Names go through c-ares with a bounded timeout, never getaddrinfo, whose
// stuck lookups would pin libuv's small thread pool on a cell without DNS.
export function nodeProbes(): Probes {
  // Never use Node's environment-aware global agent: these requests already target the proxy.
  const agent = new Agent({ keepAlive: false });
  return {
    readFile: readProbeFile,
    tcpConnect: (host, port, timeoutMs) =>
      new Promise<string>((resolve) => {
        const socket = connect({ host, port });
        const done = (result: string) => {
          clearTimeout(deadline);
          socket.destroy();
          resolve(result);
        };
        const deadline = setTimeout(() => done("timeout"), timeoutMs);
        socket.once("connect", () => done("connected"));
        socket.once("error", (err: NodeJS.ErrnoException) => done(err.code ?? "probe error"));
      }),
    resolve: async (name, timeoutMs) => {
      const resolver = new dns.Resolver({ timeout: timeoutMs, tries: 1 });
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Remember either family's answer even if the other family remains pending until timeout.
      const addresses: string[] = [];
      const failures: string[] = [];
      const verdict = () =>
        failures.find((code) => !NO_DNS.has(code)) ??
        (addresses.length > 0 ? addresses : (failures[0] ?? "ENODATA"));
      try {
        const queries = [resolver.resolve4(name), resolver.resolve6(name)].map((query) =>
          query.then(
            (found) => {
              addresses.push(...found);
            },
            (err: NodeJS.ErrnoException) => {
              failures.push(err.code ?? "probe error");
            },
          ),
        );
        return await Promise.race([
          Promise.all(queries).then(verdict),
          new Promise<string[] | string>((resolve) => {
            timer = setTimeout(() => {
              failures.push("timeout");
              resolve(verdict());
              resolver.cancel();
            }, timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        resolver.cancel();
      }
    },
    proxyGet: (proxy, url, authorization, timeoutMs) =>
      new Promise<ProxyReply | string>((resolve) => {
        let settled = false;
        const done = (reply: ProxyReply | string) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          req.destroy();
          resolve(reply);
        };
        const req = request({
          host: proxy.host,
          port: proxy.port,
          method: "GET",
          path: url,
          agent,
          headers: {
            host: new URL(url).host,
            connection: "close",
            ...(authorization ? { "proxy-authorization": authorization } : {}),
          },
        });
        const deadline = setTimeout(() => done("timeout"), timeoutMs);
        req.once("error", () => done("proxy request failed"));
        req.once("upgrade", (_res, socket) => {
          socket.destroy();
          done("unexpected proxy upgrade");
        });
        req.once("response", (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 65_536) {
              done("proxy response too large");
              return;
            }
            chunks.push(chunk);
          });
          res.once("error", () => done("incomplete proxy response"));
          res.once("end", () =>
            done({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
          );
        });
        req.end();
      }),
    run: (command, args, timeoutMs) =>
      new Promise((resolve) => {
        execFile(
          command,
          args,
          { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 256 * 1024 },
          (err, stdout) => {
            const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
            resolve({ code, stdout: String(stdout) });
          },
        );
      }),
  };
}

async function readProbeFile(path: string): Promise<string | undefined> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  const max = 4 * 1024 * 1024;
  try {
    // A cell can replace paths with FIFOs/devices. Do not block opening one or read it as a store.
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > max) return undefined;
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(65_536, max + 1 - size));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      size += bytesRead;
      if (size > max) return undefined;
      if (bytesRead === 0) return Buffer.concat(chunks).toString("utf8");
      chunks.push(buffer.subarray(0, bytesRead));
    }
  } catch {
    return undefined;
  } finally {
    await file?.close();
  }
}

// The readiness probe asks every second while a cell boots: one run at a time, and a result is
// reused for two seconds.
export function cachedSelfTest(
  run: () => Promise<SelfTestReport>,
  ttlMs = 2000,
): () => Promise<SelfTestReport> {
  let last: { at: number; report: SelfTestReport } | undefined;
  let running: Promise<SelfTestReport> | undefined;
  return () => {
    if (last && performance.now() - last.at < ttlMs) return Promise.resolve(last.report);
    running ??= Promise.resolve()
      .then(run)
      .then((report) => {
        last = { at: performance.now(), report };
        return report;
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };
}

export function selfTestConfigFromEnv(env: NodeJS.ProcessEnv): SelfTestConfig {
  return {
    cellId: env.LOCALDOT_CELL_ID || undefined,
    gate: env.LOCALDOT_GATE_ADDR ? { host: env.LOCALDOT_GATE_ADDR, port: 3128 } : undefined,
    forwarder: { host: "127.0.0.1", port: 3129 },
    tokenFile: "/etc/localdot/cell/proxy-token",
    caFile: "/etc/localdot/cell/ca.pem",
    systemBundle: "/etc/ssl/certs/ca-certificates.crt",
    nssDb: "/config/.pki/nssdb",
    timeoutMs: 2000,
  };
}
