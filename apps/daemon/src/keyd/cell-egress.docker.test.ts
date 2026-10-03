import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { imagesFromEnv } from "../cells/images.ts";
import { probeDesktopd } from "../cells/readiness.ts";
import { DOCKER_TESTS } from "../cells/testing/docker-cli.ts";
import { auditLines, type KeydCell, startKeydCell } from "./testing/keyd-cell.ts";
import { TEST_KEYD_PORTS } from "./testing/keyd-process.ts";

// S4's run.sh and chromium.sh, ported (Part 4a Task 17 pins the same probes in process): every
// probe runs in a real desktop cell, through its forwarder, its gate and its keyd listener, to the
// real internet (example.com, postman-echo.com and nip.io must be reachable from this Mac).
const VALUE = `p4b-${randomBytes(12).toString("hex")}`;
// Public fixture credentials, never a real account or API key. The upstream auth decision
// proves replacement independently of our response scrubber and audit flag.
const VERIFIER = `Basic ${Buffer.from("postman:password").toString("base64")}`;
const UNKNOWN = "ld_key_AAAAAAAAAAAAAAAAAAAAAA_AAAAAA";

describe.skipIf(!DOCKER_TESTS)("a desktop cell reaches the web only through keyd", () => {
  let cell: KeydCell;
  let surrogate = "";
  let verifierSurrogate = "";
  let otherToken = "";
  let otherPort = 0;
  const otherId = `auth-control-${randomBytes(4).toString("hex")}`;
  const docker = (...args: string[]) =>
    execFileSync("docker", args, {
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    }).trim();
  const sequence = () => Math.max(0, ...auditLines(cell.keyd).map((l) => Number(l.seq)));
  const freshAudit = async (after: number, fields: Record<string, unknown>) => {
    await expect
      .poll(
        () =>
          auditLines(cell.keyd).find(
            (l) => Number(l.seq) > after && Object.entries(fields).every(([k, v]) => l[k] === v),
          ),
        { timeout: 3000 },
      )
      .toBeDefined();
  };
  // curl through the cell's proxy settings; -D - prints every header it receives, the proxy's
  // answer to a refused CONNECT included, so a refusal's X-Keyd-Reason is in the output.
  const curl = (args: string) => cell.sh(`curl -sS -m 30 ${args}`);
  const reason = (out: string) => /^x-keyd-reason: *(\S+)/im.exec(out)?.[1];
  const httpStatus = (out: string) => [...out.matchAll(/^HTTP\/[\d.]+ (\d{3})/gm)].at(-1)?.[1];

  beforeAll(async () => {
    cell = await startKeydCell([
      {
        binding: {
          id: "echo",
          kind: "http",
          hosts: ["postman-echo.com"],
          header: "Authorization",
          format: "bearer",
        },
        value: VALUE,
      },
      {
        binding: {
          id: "verifier",
          kind: "http",
          hosts: ["postman-echo.com"],
          header: "Authorization",
          format: "raw",
        },
        value: VERIFIER,
      },
    ]);
    const printed = cell.sh('printf %s "$LOCALDOT_KEY_ECHO"');
    expect(printed.status).toBe(0);
    surrogate = printed.out;
    expect(surrogate).toMatch(/^ld_key_[0-9A-Za-z]{22}_[0-9A-Za-z]{6}$/);
    const verifier = cell.sh('printf %s "$LOCALDOT_KEY_VERIFIER"');
    expect(verifier.status).toBe(0);
    verifierSurrogate = verifier.out;
    expect(verifierSurrogate).toMatch(/^ld_key_[0-9A-Za-z]{22}_[0-9A-Za-z]{6}$/);
    otherPort =
      cell.record.keydPort === TEST_KEYD_PORTS.from
        ? TEST_KEYD_PORTS.from + 1
        : TEST_KEYD_PORTS.from;
    const other = await cell.client.openCell({
      cellId: otherId,
      role: "desktop",
      port: otherPort,
      secrets: [],
    });
    otherToken = other.proxyToken;
  }, 600_000);
  afterAll(async () => {
    if (!cell) return;
    try {
      await cell.client.closeCell(otherId);
    } finally {
      await cell.close();
    }
  });

  it("has no way out but its gate: no route, no DNS, no IPv6, no host, no LAN", async () => {
    const endpoints = cell.orchestrator.endpoints(cell.id);
    expect(endpoints).toBeDefined();
    if (!endpoints) throw new Error("missing cell endpoints");
    const health = await probeDesktopd(endpoints.desktopd);
    expect(health?.ok).toBe(true);
    expect(health?.selftest?.checks.map((c) => c.id).sort()).toEqual(
      [
        "route",
        "direct-ipv4",
        "direct-ipv6",
        "dns",
        "host",
        "gateway",
        "keyd-token",
        "keyd",
        "forwarder",
        "ca-system",
        "ca-nss",
      ].sort(),
    );
    for (const check of health?.selftest?.checks ?? []) expect(check.ok, check.id).toBe(true);
    // Unlike curl exit 7 alone, these production self-tests distinguish unreachable addresses
    // from connection refusal (which would prove the Docker host was reachable).
    const direct = (args: string) => cell.sh(`curl --noproxy '*' -sS -m 5 ${args}`);
    expect(direct("https://example.com/").status).toBe(6);
    expect(direct("https://1.1.1.1/").status).toBe(7);
    expect(direct("-6 'https://[2606:4700:4700::1111]/'").status).toBe(7);
    expect(direct("http://host.docker.internal:1234/").status).toBe(6);
    expect(direct("http://192.168.65.254:1234/").status).toBe(7);
    expect(direct("http://192.168.65.254:11434/").status).toBe(7);
    for (const port of [80, 8081, 8082])
      expect(direct(`http://${cell.record.docker.gateInternalIp}:${port}/`).status).toBe(7);
    expect(cell.sh("getent hosts example.com").status).toBe(2);
  });

  it("answers keyd's health check with this cell's id, and refuses a request without its token", () => {
    const health = curl("http://keyd.ldot/health");
    expect(health.status).toBe(0);
    expect(JSON.parse(health.out)).toEqual({ ok: true, cell: cell.id });
    const gate = `${cell.record.docker.gateInternalIp}:3128`;
    for (const proxy of [
      `http://${gate}`,
      `http://cell:${"x".repeat(43)}@${gate}`,
      `http://cell:${otherToken}@${gate}`,
    ]) {
      const res = cell.sh(
        `curl -sS -m 10 -o /dev/null -w '%{http_code}' -x ${proxy} http://keyd.ldot/health`,
      );
      expect(res).toEqual({ status: 0, out: "407" });
    }
  });

  it("refuses another container that finds the cell's listener, with or without a token", () => {
    const request = (port: number, token?: string) => {
      const name = `localdot-test-intruder-${randomBytes(4).toString("hex")}`;
      const target = `host.docker.internal:${port}`;
      try {
        return docker(
          "run",
          "--rm",
          "--name",
          name,
          "--entrypoint",
          "curl",
          imagesFromEnv().desktop,
          "-sS",
          "-m",
          "10",
          "-w",
          "\n%{http_code}",
          "-x",
          token ? `http://cell:${token}@${target}` : `http://${target}`,
          "http://keyd.ldot/health",
        );
      } finally {
        // --rm normally owns cleanup; a timed-out CLI may leave the container running.
        if (docker("ps", "-aq", "--filter", `name=^/${name}$`)) docker("rm", "-fv", name);
      }
    };
    for (const token of [undefined, "x".repeat(43), otherToken]) {
      expect(request(cell.record.keydPort, token).split("\n").at(-1)).toBe("407");
    }
    const own = request(otherPort, otherToken).split("\n");
    expect(own.pop()).toBe("200");
    expect(JSON.parse(own.join("\n"))).toEqual({ ok: true, cell: otherId });
  });

  it("swaps the surrogate for the bound host, scrubs the reflection, and audits the swap", async () => {
    const after = sequence();
    const echo = curl(
      `https://postman-echo.com/headers -H "Authorization: Bearer $LOCALDOT_KEY_ECHO"`,
    );
    expect(echo.status).toBe(0);
    expect(JSON.parse(echo.out).headers.authorization).toBe(`Bearer ${surrogate}`);
    expect(echo.out).not.toContain(VALUE);
    await freshAudit(after, {
      cell: cell.id,
      port: cell.record.keydPort,
      kind: "request",
      method: "GET",
      host: "postman-echo.com",
      path: "/headers",
      secretId: "echo",
      swapped: true,
      status: 200,
      decision: "allow",
    });
  });

  it("proves substitution with an independent upstream authentication decision", async () => {
    const upstream = async (authorization: string) => {
      const r = await fetch(
        `https://postman-echo.com/basic-auth?probe=${randomBytes(8).toString("hex")}`,
        {
          headers: { authorization, "cache-control": "no-cache" },
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        },
      );
      return { status: r.status, body: await r.text() };
    };
    expect(await upstream(verifierSurrogate)).toEqual({ status: 400, body: "Bad Request" });
    const positive = await upstream(VERIFIER);
    expect(positive.status).toBe(200);
    expect(JSON.parse(positive.body)).toEqual({ authenticated: true });
    const after = sequence();
    const actual = curl(
      `-w '\n%{http_code}' 'https://postman-echo.com/basic-auth?probe=${randomBytes(8).toString("hex")}' -H "Authorization: $LOCALDOT_KEY_VERIFIER" -H 'Cache-Control: no-cache'`,
    );
    expect(actual.status).toBe(0);
    const lines = actual.out.split("\n");
    expect(lines.pop()).toBe("200");
    expect(JSON.parse(lines.join("\n"))).toEqual({ authenticated: true });
    await freshAudit(after, {
      cell: cell.id,
      kind: "request",
      method: "GET",
      host: "postman-echo.com",
      path: "/basic-auth",
      secretId: "verifier",
      swapped: true,
      status: 200,
      decision: "allow",
    });
  });

  it("lets the bound host be browsed without a surrogate (P4a-R8)", () => {
    expect(curl("-o /dev/null -w '%{http_code}' https://postman-echo.com/get")).toEqual({
      status: 0,
      out: "200",
    });
  });

  it("blocks unknown and misplaced surrogates wherever they appear", async () => {
    let after = sequence();
    const unknown = curl(
      `-o /dev/null -D - https://postman-echo.com/headers -H "Authorization: Bearer ${UNKNOWN}"`,
    );
    expect(unknown.status).toBe(0);
    expect(httpStatus(unknown.out)).toBe("403");
    expect(reason(unknown.out)).toBe("unknown-surrogate");
    await freshAudit(after, {
      cell: cell.id,
      port: cell.record.keydPort,
      kind: "request",
      method: "GET",
      host: "postman-echo.com",
      path: "/headers",
      status: 403,
      decision: "deny",
      reason: "unknown-surrogate",
    });
    after = sequence();
    const propfind = curl(
      `-o /dev/null -D - -X PROPFIND https://postman-echo.com/ -H "Authorization: Bearer ${UNKNOWN}"`,
    );
    expect(propfind.status).toBe(0);
    expect(httpStatus(propfind.out)).toBe("403");
    expect(reason(propfind.out)).toBe("unknown-surrogate");
    await freshAudit(after, {
      cell: cell.id,
      port: cell.record.keydPort,
      kind: "request",
      method: "PROPFIND",
      host: "postman-echo.com",
      path: "/",
      status: 403,
      decision: "deny",
      reason: "unknown-surrogate",
    });
    for (const args of [
      `https://postman-echo.com/headers -H "X-Api-Key: $LOCALDOT_KEY_ECHO"`,
      `http://postman-echo.com/headers -H "Authorization: Bearer $LOCALDOT_KEY_ECHO"`,
      `"https://postman-echo.com/$LOCALDOT_KEY_ECHO"`,
    ]) {
      after = sequence();
      const res = curl(`-o /dev/null -D - ${args}`);
      expect(res.status).toBe(0);
      expect(httpStatus(res.out)).toBe("403");
      expect(reason(res.out)).toBe("misplaced-surrogate");
      await freshAudit(after, {
        cell: cell.id,
        port: cell.record.keydPort,
        kind: "request",
        method: "GET",
        host: "postman-echo.com",
        status: 403,
        decision: "deny",
        reason: "misplaced-surrogate",
      });
    }
  });

  it("passes a surrogate sent to an unbound host through its tunnel unswapped (P4a-R9)", async () => {
    const after = sequence();
    const res = curl(
      `https://www.postman-echo.com/headers -H "Authorization: Bearer $LOCALDOT_KEY_ECHO"`,
    );
    expect(res.status).toBe(0);
    expect(JSON.parse(res.out).headers.authorization).toBe(`Bearer ${surrogate}`);
    expect(res.out).not.toContain(VALUE);
    await freshAudit(after, {
      cell: cell.id,
      kind: "connect",
      host: "www.postman-echo.com",
      mode: "passthrough",
      status: 200,
      decision: "allow",
    });
    expect(
      auditLines(cell.keyd)
        .filter((l) => Number(l.seq) > after && l.host === "www.postman-echo.com")
        .every((l) => !l.swapped),
    ).toBe(true);
  });

  it("passes example.com through with its own certificate", () => {
    const res = curl("-o /dev/null -w '%{http_code} %{ssl_verify_result}' https://example.com/");
    expect(res).toEqual({ status: 0, out: "200 0" });
    const certificate = (host: string) =>
      cell.sh(
        `timeout 20 openssl s_client -proxy 127.0.0.1:3129 -connect ${host}:443 -servername ${host} -verify_hostname ${host} -verify_return_error </dev/null 2>&1`,
      );
    const example = certificate("example.com");
    expect(example.status).toBe(0);
    expect(example.out).toContain("Verify return code: 0 (ok)");
    expect(example.out).not.toContain("localDot");
    const bound = certificate("postman-echo.com");
    expect(bound.status).toBe(0);
    expect(bound.out).toContain("Verify return code: 0 (ok)");
    expect(bound.out).toContain("localDot");
  });

  it("rejects a Host authority that disagrees with the bound TLS tunnel", async () => {
    for (const withKey of [false, true]) {
      const after = sequence();
      const res = curl(
        `--http1.1 -o /dev/null -D - https://postman-echo.com/headers -H 'Host: www.postman-echo.com' ${withKey ? '-H "Authorization: Bearer $LOCALDOT_KEY_ECHO"' : ""}`,
      );
      expect(res.status).toBe(0);
      expect(httpStatus(res.out)).toBe(withKey ? "403" : "421");
      expect(reason(res.out)).toBe(withKey ? "misplaced-surrogate" : "host-mismatch");
      await freshAudit(after, {
        cell: cell.id,
        kind: "request",
        method: "GET",
        host: "postman-echo.com",
        path: "/headers",
        decision: "deny",
        reason: withKey ? "misplaced-surrogate" : "host-mismatch",
      });
    }
  });

  it("refuses addresses, odd ports and private names by policy", async () => {
    // --noproxy '' sends loopback through the proxy too: the cell's NO_PROXY keeps its own
    // loopback services (CDP, desktopd) local, and that is not what these probe.
    const refused = async (url: string) => {
      const after = sequence();
      const res = curl(`--noproxy '' -o /dev/null -D - '${url}'`);
      expect(httpStatus(res.out), url).toBe("403");
      const target = new URL(url);
      const connect = target.protocol === "https:";
      const host =
        connect && reason(res.out) === "ip-literal"
          ? `${target.hostname}:${target.port || "443"}`
          : target.hostname.replace(/^\[|\]$/g, "");
      await freshAudit(after, {
        cell: cell.id,
        port: cell.record.keydPort,
        kind: connect ? "connect" : "request",
        method: connect ? "CONNECT" : "GET",
        host,
        status: 403,
        decision: "deny",
        reason: reason(res.out),
      });
      return { status: res.status, reason: reason(res.out) };
    };
    for (const url of [
      "http://169.254.169.254/",
      "http://10.0.0.1/",
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://0.0.0.0/",
    ]) {
      expect(await refused(url)).toEqual({ status: 0, reason: "ip-literal" });
    }
    expect(await refused("https://1.1.1.1/")).toEqual({ status: 7, reason: "ip-literal" });
    expect(await refused("http://example.com:8080/")).toEqual({
      status: 0,
      reason: "port-not-allowed",
    });
    expect(await refused("https://example.com:8443/")).toEqual({
      status: 7,
      reason: "port-not-allowed",
    });
    expect(await refused("http://printer.local/")).toEqual({ status: 0, reason: "host-denied" });
    expect(await refused("https://printer.local/")).toEqual({ status: 7, reason: "host-denied" });
    expect(await refused("http://localhost/")).toEqual({ status: 0, reason: "host-invalid" });
  });

  it("refuses names that resolve to the Mac, Docker Desktop or a private range at dial time", async () => {
    for (const name of [
      "127.0.0.1.nip.io",
      "192.168.65.254.nip.io",
      "169.254.169.254.nip.io",
      "10.0.0.1.nip.io",
    ]) {
      let after = sequence();
      const res = curl(`-o /dev/null -D - http://${name}/`);
      expect(res.status).toBe(0);
      expect(httpStatus(res.out)).toBe("403");
      expect(reason(res.out)).toBe("address-denied");
      await freshAudit(after, {
        cell: cell.id,
        kind: "request",
        host: name,
        decision: "deny",
        reason: "address-denied",
      });
      after = sequence();
      const tls = curl(`-o /dev/null -D - https://${name}/`);
      // CONNECT is accepted before SNI and guarded DNS dialing, so the TLS handshake fails.
      expect(tls.status).toBe(35);
      await freshAudit(after, {
        cell: cell.id,
        kind: "connect",
        host: name,
        decision: "deny",
        reason: "address-denied",
      });
    }
  });

  it("takes Chromium to the web through keyd, trusting the cell's CA for the bound host only", () => {
    const chromium = (url: string) =>
      cell.sh(
        `timeout 60 /usr/bin/chromium --user-data-dir=/tmp/keyd-egress-${randomBytes(6).toString("hex")} --headless=new --disable-gpu --disable-quic --proxy-server="$HTTPS_PROXY" --dump-dom ${url}`,
      );
    const example = chromium("https://example.com/");
    expect(example.status).toBe(0);
    expect(example.out).toContain("Example Domain");
    const bound = chromium("https://postman-echo.com/get");
    expect(bound.status).toBe(0);
    expect(bound.out).toContain('"host":"postman-echo.com"');
    expect(bound.out).not.toContain("ERR_CERT");
  });

  it("takes Node's fetch and Python through the proxy, and keeps it for sudo and apt", () => {
    const node = cell.sh(
      `timeout 30 /opt/node/bin/node -e 'fetch("https://example.com/").then((r) => console.log(r.status))'`,
    );
    expect(node).toEqual({ status: 0, out: "200\n" });
    const python = cell.sh(
      `timeout 30 python3 -c 'import urllib.request as u; print(u.urlopen(u.Request("https://example.com/", headers={"User-Agent": "localdot-test"})).status)'`,
    );
    expect(python).toEqual({ status: 0, out: "200\n" });
    const nodeBound = cell.sh(
      `timeout 30 /opt/node/bin/node -e 'fetch("https://postman-echo.com/get").then(async (r) => console.log(r.status, (await r.json()).headers.host))'`,
    );
    expect(nodeBound).toEqual({ status: 0, out: "200 postman-echo.com\n" });
    const pythonBound = cell.sh(
      `timeout 30 python3 -c 'import urllib.request as u,json; r=u.urlopen(u.Request("https://postman-echo.com/get", headers={"User-Agent": "localdot-test"})); print(r.status,json.load(r)["headers"]["host"])'`,
    );
    expect(pythonBound).toEqual({ status: 0, out: "200 postman-echo.com\n" });
    expect(
      cell.sh(
        `sudo -n timeout 30 /opt/node/bin/node -e 'fetch("https://postman-echo.com/get").then(async (r) => console.log(r.status, (await r.json()).headers.host))'`,
      ),
    ).toEqual({ status: 0, out: "200 postman-echo.com\n" });
    const sudo = cell.sh("sudo -n env | grep -E '^(HTTPS_PROXY|NODE_EXTRA_CA_CERTS)=' | sort");
    expect(sudo).toEqual({
      status: 0,
      out: "HTTPS_PROXY=http://127.0.0.1:3129\nNODE_EXTRA_CA_CERTS=/etc/localdot/cell/ca.pem\n",
    });
    for (const scheme of ["http", "https"])
      expect(cell.sh(`apt-config dump Acquire::${scheme}::Proxy`)).toEqual({
        status: 0,
        out: `Acquire::${scheme}::Proxy "http://127.0.0.1:3129";\n`,
      });
  });
  it("fails readiness if Task 7's Chromium trust installation is absent", async () => {
    const endpoints = cell.orchestrator.endpoints(cell.id);
    if (!endpoints) throw new Error("missing cell endpoints");
    const probe = () => probeDesktopd(endpoints.desktopd);
    await expect
      .poll(async () => (await probe())?.ok, { timeout: 12_000, interval: 500 })
      .toBe(true);
    try {
      expect(cell.sh("certutil -d sql:/config/.pki/nssdb -D -n localdot-cell").status).toBe(0);
      await expect
        .poll(async () => (await probe())?.selftest?.checks.find((c) => c.id === "ca-nss")?.ok, {
          timeout: 12_000,
          interval: 500,
        })
        .toBe(false);
      const broken = await probe();
      expect(broken?.ok).toBe(false);
      for (const id of ["ca-system", "forwarder", "keyd"])
        expect(broken?.selftest?.checks.find((c) => c.id === id)?.ok, id).toBe(true);
    } finally {
      expect(
        cell.sh(
          "certutil -d sql:/config/.pki/nssdb -A -t 'C,,' -n localdot-cell -i /etc/localdot/cell/ca.pem",
        ).status,
      ).toBe(0);
      await expect
        .poll(async () => (await probe())?.ok, { timeout: 12_000, interval: 500 })
        .toBe(true);
    }
  });

  it("attributes every audit line before filtering, and leaks no credential or surrogate", () => {
    const lines = auditLines(cell.keyd);
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) {
      if (line.kind !== "request" && line.kind !== "connect") continue;
      expect([cell.id, otherId]).toContain(line.cell);
      expect(line.port).toBe(line.cell === cell.id ? cell.record.keydPort : otherPort);
    }
    const raw = readFileSync(join(cell.keyd.home, "keyd", "audit.jsonl"), "utf8");
    for (const value of [VALUE, VERIFIER, surrogate, verifierSurrogate, otherToken])
      expect(raw).not.toContain(value);
    const proxyToken = cell.sh("cat /etc/localdot/cell/proxy-token");
    expect(proxyToken.status).toBe(0);
    expect(proxyToken.out.trim()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(raw).not.toContain(proxyToken.out.trim());
    expect(raw).not.toMatch(/ld_[a-z0-9]{2,12}_[0-9A-Za-z]{22}_[0-9A-Za-z]{6}/);
    expect(raw).toContain("[surrogate:");
  });
});
