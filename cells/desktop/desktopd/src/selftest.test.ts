import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { SELFTEST_CHECK_IDS, selfTestPassed } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  cachedSelfTest,
  nodeProbes,
  type Probes,
  type ProxyReply,
  runSelfTest,
  type SelfTestConfig,
  selfTestConfigFromEnv,
} from "./selftest.ts";

const CELL = "01JXYZ0000000000000000ABCD";
const TOKEN = "j6CLzsRw79yMKkRwPznckks1fdcXOOnPN3DYp3Al_gk";
const pem = (label: string, der: Buffer) =>
  `-----BEGIN ${label}-----\n${der.toString("base64")}\n-----END ${label}-----\n`;
const CA_DER = Buffer.from("the cell's CA, DER-encoded");
const CA = pem("CERTIFICATE", CA_DER);
// What `openssl x509 -addtrust serverAuth` writes: the DER, then trust settings for serverAuth
// only, a form only OpenSSL reads.
const trusted = () =>
  pem(
    "TRUSTED CERTIFICATE",
    Buffer.concat([CA_DER, Buffer.from("300c300a06082b06010505070301", "hex")]),
  );
const OTHER = pem("CERTIFICATE", Buffer.from("another root"));
const cfg: SelfTestConfig = {
  ...selfTestConfigFromEnv({ LOCALDOT_CELL_ID: CELL, LOCALDOT_GATE_ADDR: "172.24.0.10" }),
  timeoutMs: 50,
};
const ROUTE_ISOLATED =
  "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\nlo\t0000007F\t00000000\t0001\t0\t0\t0\t000000FF\neth0\t000018AC\t00000000\t0001\t0\t0\t0\t0000FFFF\n";
const ROUTE_DEFAULT = `${ROUTE_ISOLATED}eth0\t00000000\t010018AC\t0003\t0\t0\t0\t00000000\n`;

// A sealed cell as the real one answers (verified in a real topology): no route, no DNS, the gate
// reaching exactly this cell's keyd listener, and the CA in both stores.
function sealedCell(over: Partial<Probes> = {}): Probes {
  const files: Record<string, string> = {
    "/proc/net/route": ROUTE_ISOLATED,
    "/proc/net/ipv6_route":
      "00000000000000000000000000000001 80 00000000000000000000000000000000 00 00000000000000000000000000000000 00000000 00000001 00000000 00200001       lo\n",
    [cfg.tokenFile]: `${TOKEN}\n`,
    [cfg.caFile]: CA,
    [cfg.systemBundle]: `${OTHER}${CA}`,
  };
  const health = (cell = CELL): ProxyReply => ({
    status: 200,
    body: JSON.stringify({ cell, ok: true }),
  });
  return {
    readFile: async (path) => files[path],
    tcpConnect: async () => "ENETUNREACH",
    resolve: async () => "ESERVFAIL",
    proxyGet: async (proxy, _url, authorization) => {
      if (proxy.port === 3129) return health();
      return authorization === `Basic ${Buffer.from(`cell:${TOKEN}`).toString("base64")}`
        ? health()
        : { status: 407, body: "" };
    },
    run: async (_cmd, args) =>
      args.includes("-a")
        ? { code: 0, stdout: CA }
        : {
            code: 0,
            stdout:
              "\nCertificate Nickname   Trust Attributes\n\nlocaldot-cell                C,,  \n",
          },
    ...over,
  };
}

const failed = async (probes: Probes) =>
  (await runSelfTest(cfg, probes)).checks.filter((c) => !c.ok).map((c) => c.id);

describe("runSelfTest", () => {
  it("passes a sealed cell, with every check the daemon requires", async () => {
    const report = await runSelfTest(cfg, sealedCell());
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.id)).toEqual(SELFTEST_CHECK_IDS);
    expect(selfTestPassed(report)).toBe(true);
  });

  it("fails on every way out of the cell, naming the check", async () => {
    const open = (target: string) => async (host: string, port: number) =>
      `${host}:${port}` === target ? "connected" : "ENETUNREACH";
    const files = sealedCell();
    expect(
      await failed(
        sealedCell({
          readFile: async (p) => (p === "/proc/net/route" ? ROUTE_DEFAULT : files.readFile(p)),
        }),
      ),
    ).toEqual(["route"]);
    expect(await failed(sealedCell({ tcpConnect: open("1.1.1.1:443") }))).toEqual(["direct-ipv4"]);
    expect(await failed(sealedCell({ tcpConnect: open("2606:4700:4700::1111:443") }))).toEqual([
      "direct-ipv6",
    ]);
    expect(
      await failed(
        sealedCell({
          resolve: async (n) => (n === "example.com" ? ["93.184.215.14"] : "ESERVFAIL"),
        }),
      ),
    ).toEqual(["dns"]);
    expect(await failed(sealedCell({ tcpConnect: open("192.168.65.254:1234") }))).toEqual(["host"]);
    expect(await failed(sealedCell({ tcpConnect: open("172.24.0.1:80") }))).toEqual(["gateway"]);
    expect(
      await failed(
        sealedCell({
          resolve: async (n) => (n === "host.docker.internal" ? ["192.168.65.7"] : "ESERVFAIL"),
          tcpConnect: open("192.168.65.7:11434"),
        }),
      ),
    ).toEqual(["host"]);
  });

  it("fails when the network's gateway address answers, even with a refusal", async () => {
    const answer = (result: string) => async (host: string, port: number) =>
      `${host}:${port}` === "172.24.0.1:53" ? result : "EHOSTUNREACH";
    expect(await failed(sealedCell({ tcpConnect: answer("ECONNREFUSED") }))).toEqual(["gateway"]);
    expect(await failed(sealedCell({ tcpConnect: answer("connected") }))).toEqual(["gateway"]);
    const quiet = await runSelfTest(cfg, sealedCell({ tcpConnect: answer("timeout") }));
    expect(quiet.checks.find((c) => c.id === "gateway")).toMatchObject({
      ok: true,
      detail: "172.24.0.1: timeout, EHOSTUNREACH",
    });
    const base = sealedCell();
    const noNetwork = sealedCell({
      readFile: async (p) =>
        p === "/proc/net/route" ? ROUTE_ISOLATED.split("eth0")[0] : base.readFile(p),
    });
    expect(await failed(noNetwork)).toEqual(["gateway"]);
  });

  it("fails when keyd answers without the token, for another cell, or not at all", async () => {
    const base = sealedCell();
    expect(
      await failed(
        sealedCell({
          proxyGet: async () => ({ status: 200, body: JSON.stringify({ ok: true, cell: CELL }) }),
        }),
      ),
    ).toEqual(["keyd-token"]);
    expect(
      await failed(
        sealedCell({
          proxyGet: async (proxy, url, auth, ms) =>
            auth
              ? { status: 200, body: JSON.stringify({ ok: true, cell: "another-cell" }) }
              : base.proxyGet(proxy, url, auth, ms),
        }),
      ),
    ).toEqual(["keyd"]);
    expect(await failed(sealedCell({ proxyGet: async () => "timeout" }))).toEqual([
      "keyd-token",
      "keyd",
      "forwarder",
    ]);
    expect(
      await failed(
        sealedCell({
          proxyGet: async (p, u, a, m) =>
            p.port === 3129 ? { status: 502, body: "" } : base.proxyGet(p, u, a, m),
        }),
      ),
    ).toEqual(["forwarder"]);
  });

  it("fails closed without a gate, a cell id, a token or the CA", async () => {
    const base = sealedCell();
    const without = (path: string) =>
      sealedCell({ readFile: async (p) => (p === path ? undefined : base.readFile(p)) });
    expect(
      (await runSelfTest({ ...cfg, gate: undefined }, sealedCell())).checks
        .filter((c) => !c.ok)
        .map((c) => c.id),
    ).toEqual(["keyd-token", "keyd"]);
    expect((await runSelfTest({ ...cfg, cellId: undefined }, sealedCell())).ok).toBe(false);
    expect(await failed(without(cfg.tokenFile))).toEqual(["keyd"]);
    expect(await failed(without(cfg.caFile))).toEqual(["ca-system", "ca-nss"]);
    expect(await failed(without("/proc/net/route"))).toEqual(["route", "gateway"]);
  });

  it("fails unless the system store holds the cell's CA as a plain anchor, which every client reads", async () => {
    const base = sealedCell();
    const bundle = (text: string) =>
      sealedCell({ readFile: async (p) => (p === cfg.systemBundle ? text : base.readFile(p)) });
    expect(await failed(bundle(`${CA}${OTHER}`))).toEqual([]);
    // OpenSSL's per-purpose form alone: Go, rustls, GnuTLS and Java skip it, so they trust nothing.
    expect(await failed(bundle(`${OTHER}${trusted()}`))).toEqual(["ca-system"]);
    expect(await failed(bundle(OTHER))).toEqual(["ca-system"]);
  });

  it("fails when Chromium does not trust the cell's CA, or trusts another one", async () => {
    expect(await failed(sealedCell({ run: async () => ({ code: 255, stdout: "" }) }))).toEqual([
      "ca-nss",
    ]);
    expect(
      await failed(
        sealedCell({
          run: async (_c, args) =>
            args.includes("-a")
              ? {
                  code: 0,
                  stdout: pem("CERTIFICATE", Buffer.from("an older cell CA")),
                }
              : { code: 0, stdout: "localdot-cell   C,,\n" },
        }),
      ),
    ).toEqual(["ca-nss"]);
    expect(
      await failed(
        sealedCell({
          run: async (_c, a) =>
            a.includes("-a")
              ? { code: 0, stdout: CA }
              : { code: 0, stdout: "localdot-cell   ,,\n" },
        }),
      ),
    ).toEqual(["ca-nss"]);
  });

  it.each(["ECONNREFUSED", "EMFILE", "unknown error"])(
    "does not call TCP result %s proof of isolation",
    async (result) => {
      expect(await failed(sealedCell({ tcpConnect: async () => result }))).toEqual([
        "direct-ipv4",
        "direct-ipv6",
        "host",
        "gateway",
      ]);
    },
  );

  it("fails inconclusive DNS results, including host-name lookups", async () => {
    expect(await failed(sealedCell({ resolve: async () => "EMFILE" }))).toEqual(["dns", "host"]);
  });

  it.each([
    "",
    "not a routing table",
    ROUTE_ISOLATED.replace("000018AC", "000018xx"),
    ROUTE_ISOLATED.replace("0000FFFF", "0000FF0F"),
  ])("fails malformed IPv4 route evidence %#", async (table) => {
    const base = sealedCell();
    expect(
      await failed(
        sealedCell({
          readFile: async (p) => (p === "/proc/net/route" ? table : base.readFile(p)),
        }),
      ),
    ).toEqual(["route", "gateway"]);
  });

  it("recognizes indented defaults and refuses missing or malformed IPv6 evidence", async () => {
    const base = sealedCell();
    for (const [path, table] of [
      ["/proc/net/route", ROUTE_DEFAULT.replace(/\neth0/g, "\n  eth0")],
      ["/proc/net/ipv6_route", undefined],
      ["/proc/net/ipv6_route", "not a routing table"],
      [
        "/proc/net/ipv6_route",
        "  00000000000000000000000000000000 00 00000000000000000000000000000000 00 00000000000000000000000000000000 00000000 00000001 00000000 00000001 eth0\n",
      ],
    ]) {
      expect(
        await failed(
          sealedCell({
            readFile: async (p) => (p === path ? table : base.readFile(p)),
          }),
        ),
      ).toContain("route");
    }
  });

  it("isolates a thrown probe failure to its named checks without leaking the error", async () => {
    const report = await runSelfTest(
      cfg,
      sealedCell({
        tcpConnect: async () => {
          throw new Error(`private ${TOKEN}`);
        },
      }),
    );
    expect(report.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual([
      "direct-ipv4",
      "direct-ipv6",
      "host",
      "gateway",
    ]);
    expect(JSON.stringify(report)).not.toContain(TOKEN);
  });

  it("bounds a hung check and retains all eleven results", async () => {
    vi.useFakeTimers();
    try {
      const pending = runSelfTest(cfg, sealedCell({ run: () => new Promise(() => {}) }));
      await vi.advanceTimersByTimeAsync(60);
      const report = await Promise.race([pending, Promise.resolve(undefined)]);
      expect(report?.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(["ca-nss"]);
      expect(report?.checks).toHaveLength(11);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs host lookups in parallel with known-address probes within one check budget", async () => {
    vi.useFakeTimers();
    try {
      const pending = runSelfTest(
        cfg,
        sealedCell({
          resolve: async (_name, ms) => new Promise((r) => setTimeout(() => r("timeout"), ms)),
          tcpConnect: async (_host, _port, ms) =>
            new Promise((r) => setTimeout(() => r("timeout"), ms)),
        }),
      );
      await vi.advanceTimersByTimeAsync(60);
      const report = await Promise.race([pending, Promise.resolve(undefined)]);
      expect(report?.checks.filter((c) => !c.ok)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails null health and ambiguous NSS entries", async () => {
    const base = sealedCell();
    expect(
      await failed(
        sealedCell({
          proxyGet: async (p, u, a, ms) =>
            a ? { status: 200, body: "null" } : base.proxyGet(p, u, a, ms),
          run: async (c, a, ms) =>
            a.includes("-a")
              ? base.run(c, a, ms)
              : { code: 0, stdout: "localdot-cell C,,\nlocaldot-cell ,,\n" },
        }),
      ),
    ).toEqual(["keyd", "ca-nss"]);
  });

  it("fails non-canonical certificate material", async () => {
    const base = sealedCell();
    expect(
      await failed(
        sealedCell({
          readFile: async (p) =>
            p === cfg.caFile ? CA.replace("-----END", "!\n-----END") : base.readFile(p),
        }),
      ),
    ).toEqual(["ca-system", "ca-nss"]);
  });
});

describe("cachedSelfTest", () => {
  it("runs once for concurrent callers and reuses a fresh result", async () => {
    let runs = 0;
    const cached = cachedSelfTest(async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, checks: [], ms: 20 };
    }, 1000);
    await Promise.all([cached(), cached(), cached()]);
    await cached();
    expect(runs).toBe(1);
  });

  it("retries after failure and expires on elapsed time despite a backwards clock", async () => {
    vi.useFakeTimers();
    try {
      let runs = 0;
      const cached = cachedSelfTest(() => {
        if (++runs === 1) throw new Error("probe unavailable");
        return Promise.resolve({ ok: true, checks: [], ms: 1 });
      }, 100);
      await expect(cached()).rejects.toThrow("probe unavailable");
      await cached();
      vi.setSystemTime(Date.now() - 10_000);
      await vi.advanceTimersByTimeAsync(101);
      await cached();
      expect(runs).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("nodeProbes", () => {
  const probes = nodeProbes();

  it("tells a refused or unroutable connection from a connected one", async () => {
    const server = createServer((s) => s.end()).listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    expect(await probes.tcpConnect("127.0.0.1", port, 1000)).toBe("connected");
    server.close();
    await once(server, "close");
    expect(await probes.tcpConnect("127.0.0.1", port, 1000)).toBe("ECONNREFUSED");
  });

  it("asks a proxy for an absolute URL, with and without credentials", async () => {
    const seen: (string | undefined)[] = [];
    const server = createHttpServer((req, res) => {
      seen.push(`${req.url} ${req.headers["proxy-authorization"] ?? "-"}`);
      res.writeHead(req.headers["proxy-authorization"] ? 200 : 407);
      res.end(JSON.stringify({ ok: true, cell: CELL }));
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const proxy = { host: "127.0.0.1", port: (server.address() as AddressInfo).port };
    expect(await probes.proxyGet(proxy, "http://keyd.ldot/health", undefined, 1000)).toMatchObject({
      status: 407,
    });
    expect(await probes.proxyGet(proxy, "http://keyd.ldot/health", "Basic eA==", 1000)).toEqual({
      status: 200,
      body: JSON.stringify({ ok: true, cell: CELL }),
    });
    expect(seen).toEqual(["http://keyd.ldot/health -", "http://keyd.ldot/health Basic eA=="]);
    server.close();
  });

  it("reads files and runs commands without throwing", async () => {
    expect(await probes.readFile("/no/such/file")).toBeUndefined();
    expect(await probes.run("/no/such/command", [], 1000)).toMatchObject({
      code: expect.any(Number),
    });
    expect((await probes.run("echo", ["hi"], 1000)).stdout.trim()).toBe("hi");
  });
});
