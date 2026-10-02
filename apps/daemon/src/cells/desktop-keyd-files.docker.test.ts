import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { imagesFromEnv } from "./images.ts";
import {
  DOCKER_TESTS,
  docker,
  dockerExec,
  dockerExecAs,
  removeAll,
  waitFor,
} from "./testing/docker-cli.ts";

// What the image does with the files the daemon writes into /etc/localdot/cell before a start:
// the CA in the system store and in Chromium's NSS database (and gone when the file is), the
// forwarder on the cell's loopback, the surrogates in login shells, the proxy kept by sudo and apt.
const NAME = `localdot-test-keydfiles-${randomBytes(4).toString("hex")}`;
const SURROGATE = "ld_key_AbCdEfGhIjKlMnOpQrStUv_AbCdEf";

// A probe counts only with the exit status it is expected to have.
function probe(status: number, ...cmd: string[]): string {
  const r = dockerExec(NAME, ...cmd);
  expect(r.status, `${cmd.join(" ")}: ${r.out}`).toBe(status);
  return r.out;
}
function probeAs(user: string, status: number, ...cmd: string[]): string {
  const r = dockerExecAs(NAME, user, ...cmd);
  expect(r.status, `${cmd.join(" ")}: ${r.out}`).toBe(status);
  return r.out;
}

const pemBody = (pem: string) => pem.replace(/-----[^-]+-----|\s/g, "");

// How the system bundle holds a CA (argv[1]): "<plain> <trusted>", the count of plain anchors (the
// form every client reads) and of TRUSTED CERTIFICATE copies, which only OpenSSL reads.
const ANCHORS_PY = `
import base64, re, sys
der = lambda body: base64.b64decode(re.sub(r"\\s+", "", body))
blocks = re.findall(r"-----BEGIN ([A-Z ]+)-----([^-]*)-----END \\1-----", open("/etc/ssl/certs/ca-certificates.crt").read())
ca = der(re.search(r"-----BEGIN CERTIFICATE-----([^-]*)-----END CERTIFICATE-----", sys.argv[1]).group(1))
plain = sum(1 for label, body in blocks if label == "CERTIFICATE" and der(body) == ca)
trusted = sum(1 for label, body in blocks if label == "TRUSTED CERTIFICATE" and der(body).startswith(ca))
print(plain, trusted)
`;

// A CA with keyd's cell CA profile (keyd/internal/cellca/cellca.go: serverAuth only, the bound host
// permitted, its subdomains and every IP address excluded), and server leaves it signs for the bound
// host, for another host and for a subdomain of the bound one, minted in the cell.
const BOUND = "bound.localdot.test";
const MINT_SH = `
set -e
d=/root/localdot-test-ca; rm -rf "$d"; mkdir -p "$d"; cd "$d"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout ca.key -out ca.pem -days 1 -subj /CN=localdot-test-ca -addext basicConstraints=critical,CA:TRUE,pathlen:0 -addext keyUsage=critical,keyCertSign,cRLSign -addext extendedKeyUsage=serverAuth -addext 'nameConstraints=critical,permitted;DNS:${BOUND},excluded;DNS:.${BOUND},excluded;IP:0.0.0.0/0.0.0.0,excluded;IP:::/::' 2>/dev/null
for host in ${BOUND} other.localdot.test api.${BOUND}; do
  name=\${host%%.*}
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout "$name.key" -out "$name.csr" -subj "/CN=$host" 2>/dev/null
  printf 'basicConstraints=critical,CA:FALSE\\nkeyUsage=critical,digitalSignature\\nextendedKeyUsage=serverAuth\\nsubjectAltName=DNS:%s\\n' "$host" > "$name.ext"
  openssl x509 -req -in "$name.csr" -CA ca.pem -CAkey ca.key -CAcreateserial -days 1 -extfile "$name.ext" -out "$name.pem" 2>/dev/null
done
for entry in 'ip4|127.0.0.1' 'ip6|::1'; do
  name=\${entry%%|*}; ip=\${entry#*|}
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout "$name.key" -out "$name.csr" -subj /CN=ip-test 2>/dev/null
  printf 'basicConstraints=critical,CA:FALSE\\nkeyUsage=critical,digitalSignature\\nextendedKeyUsage=serverAuth\\nsubjectAltName=IP:%s\\n' "$ip" > "$name.ext"
  openssl x509 -req -in "$name.csr" -CA ca.pem -CAkey ca.key -CAcreateserial -days 1 -extfile "$name.ext" -out "$name.pem" 2>/dev/null
done
cp ca.pem /etc/localdot/cell/ca.pem
`;

// Go's side of the pin: a verifier built on the Mac for the engine's platform and copied in. It
// checks a leaf for a host against the system's anchors as any Go program in the cell does (on
// Linux, crypto/x509 reads /etc/ssl/certs/ca-certificates.crt).
const VERIFY_GO = `package main

import (
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"
)

func main() {
	raw, err := os.ReadFile(os.Args[2])
	if err != nil {
		fmt.Println(err)
		os.Exit(2)
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		fmt.Println("no PEM block")
		os.Exit(2)
	}
	leaf, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		fmt.Println(err)
		os.Exit(2)
	}
	roots, err := x509.SystemCertPool()
	if err != nil {
		fmt.Println(err)
		os.Exit(2)
	}
	if _, err := leaf.Verify(x509.VerifyOptions{DNSName: os.Args[1], Roots: roots}); err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
	fmt.Println("ok")
}
`;

function buildGoVerifier(dir: string): string {
  const src = join(dir, "verify-leaf");
  mkdirSync(src);
  writeFileSync(join(src, "go.mod"), "module verifyleaf\n\ngo 1.27\n\ntoolchain go1.27.1\n");
  writeFileSync(join(src, "main.go"), VERIFY_GO);
  const bin = join(dir, "verify-leaf.bin");
  execFileSync(process.env.GO ?? "go", ["build", "-o", bin, "."], {
    cwd: src,
    env: {
      ...process.env,
      CGO_ENABLED: "0",
      GOOS: "linux",
      GOARCH: docker("version", "--format", "{{.Server.Arch}}"),
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  return bin;
}

describe.skipIf(!DOCKER_TESTS)("the desktop image installs what keyd gives a cell", () => {
  let dir: string;
  const newCa = () =>
    docker(
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "openssl",
      imagesFromEnv().desktop,
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      "/dev/null",
      "-subj",
      `/CN=localdot-test-${randomBytes(3).toString("hex")}`,
      "-days",
      "1",
    );
  const put = (name: string, text: string) => {
    writeFileSync(join(dir, name), text);
    docker("cp", join(dir, name), `${NAME}:/etc/localdot/cell/${name}`);
  };
  const nssCa = () =>
    dockerExecAs(
      NAME,
      "abc",
      "certutil",
      "-d",
      "sql:/config/.pki/nssdb",
      "-L",
      "-n",
      "localdot-cell",
      "-a",
    );
  const anchors = (pem: string) => probe(0, "python3", "-c", ANCHORS_PY, pem).trim();
  const restart = () => {
    docker("restart", "-t", "5", NAME);
    waitFor(
      "the forwarder",
      () => dockerExec(NAME, "sh", "-c", "ss -ltn | grep -q 127.0.0.1:3129").status === 0,
      90_000,
    );
  };
  let first = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "localdot-test-keydfiles-"));
    docker(
      "create",
      "--name",
      NAME,
      "--network",
      "none",
      "--hostname",
      "localdot-keydfiles",
      "--add-host",
      "localdot-keydfiles:127.0.0.1",
      "--add-host",
      `${BOUND}:127.0.0.1`,
      "-e",
      "HTTPS_PROXY=http://127.0.0.1:3129",
      "-e",
      "NODE_EXTRA_CA_CERTS=/etc/localdot/cell/ca.pem",
      imagesFromEnv().desktop,
    );
    first = newCa();
    put("ca.pem", first);
    put("proxy-token", `${"t".repeat(43)}\n`);
    put("surrogates.sh", `export LOCALDOT_KEY_WEATHER='${SURROGATE}'\n`);
    docker("start", NAME);
    waitFor(
      "the forwarder",
      () => dockerExec(NAME, "sh", "-c", "ss -ltn | grep -q 127.0.0.1:3129").status === 0,
      90_000,
    );
  }, 180_000);
  afterAll(() => {
    removeAll({ containers: [NAME] });
    rmSync(dir, { recursive: true, force: true });
  });

  it("trusts the cell's CA in the system store and in Chromium's NSS database", () => {
    expect(probe(0, "head", "-n", "1", "/usr/local/share/ca-certificates/localdot-cell.crt")).toBe(
      "-----BEGIN CERTIFICATE-----\n",
    );
    expect(anchors(first)).toBe("1 0");
    const listed = probeAs("abc", 0, "certutil", "-d", "sql:/config/.pki/nssdb", "-L");
    expect(listed).toMatch(/^localdot-cell\s+C,,\s*$/m);
    expect(nssCa()).toMatchObject({ status: 0 });
    expect(pemBody(nssCa().out)).toBe(pemBody(first));
  });

  it("runs the forwarder as the desktop's user, on the cell's loopback only", () => {
    const listening = probe(0, "sh", "-c", "ss -ltnpH 'sport = :3129'");
    expect(listening).toContain("127.0.0.1:3129");
    expect(listening).not.toMatch(/(0\.0\.0\.0|\*|\[::\]):3129/);
    probe(0, "pgrep", "-u", "abc", "-f", "/opt/localdot/forwarder.mjs");
    // No gate in this container: the forwarder says so instead of guessing a way out.
    const answer = probeAs(
      "abc",
      0,
      "curl",
      "-sS",
      "-o",
      "/dev/null",
      "-D",
      "-",
      "-x",
      "http://127.0.0.1:3129",
      "http://keyd.ldot/health",
    );
    expect(answer).toMatch(/^HTTP\/1\.1 503/);
    expect(answer).toMatch(/^x-localdot-reason: no-gate/im);
  });

  it("puts the surrogates in login and interactive shells, and keeps the proxy through sudo and apt", () => {
    expect(probeAs("abc", 0, "bash", "-lc", 'printf %s "$LOCALDOT_KEY_WEATHER"')).toBe(SURROGATE);
    expect(probeAs("abc", 0, "bash", "-ic", 'printf %s "$LOCALDOT_KEY_WEATHER"')).toContain(
      SURROGATE,
    );
    expect(probeAs("abc", 0, "sudo", "-n", "sh", "-c", 'printf %s "$HTTPS_PROXY"')).toBe(
      "http://127.0.0.1:3129",
    );
    expect(probe(0, "apt-config", "dump", "Acquire::https::Proxy")).toBe(
      'Acquire::https::Proxy "http://127.0.0.1:3129";\n',
    );
    expect(probe(0, "visudo", "-cf", "/etc/sudoers.d/localdot-proxy")).toContain("parsed OK");
    const chromium = probeAs(
      "abc",
      0,
      "bash",
      "-x",
      "/usr/local/bin/localdot-chromium",
      "--version",
    );
    expect(chromium).toContain("--proxy-server=http://127.0.0.1:3129");
    expect(chromium).toContain("--disable-quic");
    expect(chromium).toContain("Chromium");
  });

  it("replaces the CA at the next start and forgets it when the daemon writes none", () => {
    const second = newCa();
    put("ca.pem", second);
    restart();
    const listed = probeAs("abc", 0, "certutil", "-d", "sql:/config/.pki/nssdb", "-L");
    expect(listed.match(/^localdot-cell\s/gm)).toHaveLength(1);
    expect(pemBody(nssCa().out)).toBe(pemBody(second));
    expect(anchors(second)).toBe("1 0");
    expect(anchors(first)).toBe("0 0");

    probe(0, "rm", "/etc/localdot/cell/ca.pem");
    restart();
    expect(probeAs("abc", 0, "certutil", "-d", "sql:/config/.pki/nssdb", "-L")).not.toContain(
      "localdot-cell",
    );
    probe(1, "test", "-e", "/usr/local/share/ca-certificates/localdot-cell.crt");
    expect(anchors(second)).toBe("0 0");
  }, 240_000);

  it("trusts the cell's CA as a plain anchor for its bound host only: OpenSSL, Go, curl and Python", () => {
    probe(0, "sh", "-c", MINT_SH);
    restart();
    const ca = "/root/localdot-test-ca";
    const bundle = "/etc/ssl/certs/ca-certificates.crt";
    const verify = (status: number, leaf: string) =>
      probe(
        status,
        "openssl",
        "verify",
        "-CAfile",
        bundle,
        "-purpose",
        "sslserver",
        `${ca}/${leaf}.pem`,
      );
    expect(verify(0, "bound")).toContain("OK");
    // The restriction is the certificate's own: OpenSSL refuses a leaf for a host it does not name.
    expect(verify(2, "other")).toContain("permitted subtree violation");
    expect(verify(2, "api")).toContain("excluded subtree violation");
    expect(verify(2, "ip4")).toContain("excluded subtree violation");
    expect(verify(2, "ip6")).toContain("excluded subtree violation");
    docker("cp", buildGoVerifier(dir), `${NAME}:/usr/local/bin/localdot-test-verify-leaf`);
    const goVerify = (status: number, host: string, leaf: string) =>
      probe(status, "/usr/local/bin/localdot-test-verify-leaf", host, `${ca}/${leaf}.pem`);
    expect(goVerify(0, BOUND, "bound")).toBe("ok\n");
    expect(goVerify(1, "other.localdot.test", "other")).toContain(
      "not permitted by any constraint",
    );
    expect(goVerify(1, `api.${BOUND}`, "api")).toContain(`excluded by constraint ".${BOUND}"`);
    expect(goVerify(1, "127.0.0.1", "ip4")).toContain("excluded by constraint");
    expect(goVerify(1, "::1", "ip6")).toContain("excluded by constraint");
    probe(
      0,
      "sh",
      "-c",
      `setsid openssl s_server -accept 127.0.0.1:8443 -cert ${ca}/bound.pem -key ${ca}/bound.key -www -quiet </dev/null >/dev/null 2>&1 & sleep 1`,
    );
    const url = `https://${BOUND}:8443/`;
    expect(
      probeAs(
        "abc",
        0,
        "curl",
        "--noproxy",
        "*",
        "-sS",
        "-o",
        "/dev/null",
        "-w",
        "%{ssl_verify_result}",
        url,
      ),
    ).toBe("0");
    expect(
      probeAs(
        "abc",
        0,
        "python3",
        "-c",
        `import urllib.request as u; print(u.build_opener(u.ProxyHandler({})).open("${url}").status)`,
      ),
    ).toBe("200\n");
  }, 240_000);
});
