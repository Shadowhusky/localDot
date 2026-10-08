import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  CanaryOperation,
  canaryResourceName,
} from "../../../../packages/protocol/src/canary-operation.ts";
import { CanaryReady } from "../../../../packages/protocol/src/canary-process.ts";
import { canaryTopologyClient } from "./canary-topology-client.ts";
import { canaryCellRecord } from "./canary-topology-spec.ts";

const request = vi.hoisted(() => vi.fn());
vi.mock("node:http", () => ({ request }));
afterEach(() => {
  request.mockReset();
  vi.useRealTimers();
});
const signal = () => new AbortController().signal;
const ids = {
  internal: "1".repeat(64),
  egress: "2".repeat(64),
  gate: "3".repeat(64),
  desktop: "4".repeat(64),
};
function fixture() {
  const operation = CanaryOperation.parse({
    v: 1,
    owner: "a".repeat(32),
    engineId: "fixture",
    runId: "01234567-89ab-4cde-8fab-0123456789ab",
    cellId: "01JXYZ00000000000000000001",
    phase: "active",
    directory: { device: "1", inode: "2" },
    images: {
      desktop: {
        ref: `ghcr.io/fixture/localdot-desktop@sha256:${"a".repeat(64)}`,
        id: `sha256:${"b".repeat(64)}`,
      },
      gate: {
        ref: `ghcr.io/fixture/localdot-gate@sha256:${"c".repeat(64)}`,
        id: `sha256:${"d".repeat(64)}`,
      },
    },
    resources: { desktop: null, gate: null, internal: null, egress: null, home: false },
  });
  const ready = CanaryReady.parse({
    v: 1,
    type: "ready",
    runId: operation.runId,
    cellId: operation.cellId,
    port: 49123,
    proxyToken: "t".repeat(43),
    caCertPem: `-----BEGIN CERTIFICATE-----\n${"A".repeat(128)}\n-----END CERTIFICATE-----\n`,
    surrogate: `ld_key_${"a".repeat(22)}_${"b".repeat(6)}`,
    syntheticSecret: `canary-${"e".repeat(64)}`,
    challenge: "a".repeat(32),
    url: `https://canary.localdot.invalid/v1/canary/${"a".repeat(32)}`,
  });
  const client = canaryTopologyClient("/fixture/docker.sock", operation, ready);
  const record = canaryCellRecord(operation, ready, "172.20.0.0/24", "172.21.0.0/24");
  return { client, operation, ready, record };
}
function server(
  options: {
    status?: number;
    body?: Buffer;
    headers?: Record<string, string>;
    complete?: boolean;
    manualClose?: boolean;
    stall?: boolean;
  } = {},
) {
  let close!: () => void;
  const sent: { path: string; method: string; body: Buffer }[] = [];
  request.mockImplementation((opts, callback) => {
    const req = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
    let res: Readable | undefined,
      closed = false;
    close = () => {
      if (!closed) {
        closed = true;
        req.emit("close");
      }
    };
    req.destroy.mockImplementation(() => {
      if (!options.manualClose)
        queueMicrotask(() => {
          if (!closed) {
            closed = true;
            req.emit("close");
          }
        });
    });
    req.end.mockImplementation((payload?: Buffer) => {
      const data = payload ?? Buffer.alloc(0);
      sent.push({ path: opts.path, method: opts.method, body: Buffer.from(data) });
      let status = opts.path.endsWith("/start") ? 204 : opts.path.includes("/create") ? 201 : 200,
        reply = Buffer.alloc(0);
      if (opts.path === "/v1.47/networks/create") {
        const value = JSON.parse(data.toString());
        reply = Buffer.from(
          JSON.stringify({ Id: value.Name.endsWith("-internal") ? ids.internal : ids.egress }),
        );
      }
      if (opts.path === "/v1.47/volumes/create")
        reply = Buffer.from(JSON.stringify({ ...JSON.parse(data.toString()), Options: null }));
      if (opts.path.startsWith("/v1.47/containers/create?"))
        reply = Buffer.from(
          JSON.stringify({ Id: opts.path.endsWith("-gate") ? ids.gate : ids.desktop }),
        );
      status = options.status ?? status;
      res = Object.assign(Readable.from([options.body ?? reply]), {
        statusCode: status,
        complete: options.complete ?? true,
        headers: options.headers ?? { "content-type": "application/json" },
      });
      if (!options.stall) queueMicrotask(() => callback(res));
    });
    opts.signal.addEventListener("abort", () => {
      req.emit("error", opts.signal.reason);
      res?.on("error", () => {});
      res?.destroy(opts.signal.reason);
    });
    return req;
  });
  return { sent, close: () => close() };
}
async function prepared() {
  const f = fixture();
  await f.client.createNetwork("internal", signal());
  await f.client.createNetwork("egress", signal());
  await f.client.createHome(signal());
  await f.client.createContainer("gate", f.record, signal());
  await f.client.createContainer("desktop", f.record, signal());
  return f;
}

it("creates only the bound topology and uploads three fixed files without the synthetic secret", async () => {
  const s = server(),
    f = await prepared();
  await f.client.wireDesktop(ids.desktop, f.ready, signal());
  await f.client.start(ids.gate, signal());
  await f.client.connect(ids.internal, ids.gate, f.record.docker.gateInternalIp, signal());
  await f.client.start(ids.desktop, signal());
  expect(s.sent.map((s) => s.method)).toEqual([
    "POST",
    "POST",
    "POST",
    "POST",
    "POST",
    "PUT",
    "POST",
    "POST",
    "POST",
  ]);
  expect(s.sent[0] && JSON.parse(s.sent[0].body.toString())).toMatchObject({
    Internal: true,
    EnableIPv6: false,
    Options: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" },
  });
  expect(s.sent[2] && JSON.parse(s.sent[2].body.toString())).toMatchObject({
    Name: canaryResourceName(f.operation.runId, "home"),
    Driver: "local",
  });
  expect(s.sent[3] && JSON.parse(s.sent[3].body.toString())).toMatchObject({
    User: "nobody",
    HostConfig: { ReadonlyRootfs: true, CapDrop: ["ALL"] },
  });
  const archive = s.sent[5];
  if (!archive) throw new Error("missing archive");
  expect(archive.path).toBe(
    `/v1.47/containers/${ids.desktop}/archive?path=%2Fetc%2Flocaldot%2Fcell&noOverwriteDirNonDir=true`,
  );
  const files: Record<string, string> = {};
  for (let offset = 0; archive.body[offset]; ) {
    const name =
      archive.body
        .subarray(offset, offset + 100)
        .toString()
        .split("\0")[0] ?? "";
    const size = Number.parseInt(
      archive.body
        .subarray(offset + 124, offset + 136)
        .toString()
        .replace(/\0.*$/, ""),
      8,
    );
    files[name] = archive.body.subarray(offset + 512, offset + 512 + size).toString();
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  expect(Object.keys(files)).toEqual(["proxy-token", "ca.pem", "surrogates.sh"]);
  expect(files["proxy-token"]).toBe(`${f.ready.proxyToken}\n`);
  expect(files["ca.pem"]).toBe(f.ready.caCertPem);
  expect(files["surrogates.sh"]).toContain(`LOCALDOT_KEY_DIAGNOSTIC='${f.ready.surrogate}'`);
  for (const sent of s.sent) expect(sent.body.includes(f.ready.syntheticSecret)).toBe(false);
  for (const [opts] of request.mock.calls) {
    expect(opts.socketPath).toBe("/fixture/docker.sock");
    expect(opts.hostname).toBeUndefined();
    expect(opts.headers.authorization).toBeUndefined();
    expect(opts.headers["X-Registry-Auth"]).toBeUndefined();
  }
});

it("refuses unowned IDs and out-of-order start/connect without sending", async () => {
  server();
  const f = fixture();
  await expect(f.client.start(ids.gate, signal())).rejects.toThrow();
  await expect(
    f.client.connect(ids.internal, ids.gate, f.record.docker.gateInternalIp, signal()),
  ).rejects.toThrow();
  await expect(f.client.wireDesktop(ids.desktop, f.ready, signal())).rejects.toThrow();
  await expect(f.client.createContainer("gate", f.record, signal())).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});

it.each(["port", "name", "token", "public-address"])(
  "refuses %s record before create",
  async (fault) => {
    server();
    const f = fixture();
    await f.client.createNetwork("internal", signal());
    await f.client.createNetwork("egress", signal());
    await f.client.createHome(signal());
    request.mockClear();
    if (fault === "port") f.record.keydPort++;
    if (fault === "name") f.record.docker.homeVolume = "foreign";
    if (fault === "token") f.record.tokens.desktopd = "invalid";
    if (fault === "public-address") f.record.docker.gateEgressIp = "8.8.8.8";
    await expect(f.client.createContainer("gate", f.record, signal())).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  },
);

it("refuses a second create after a lost reply and blocks later mutations", async () => {
  server({ status: 500 });
  const f = fixture();
  await expect(f.client.createNetwork("internal", signal())).rejects.toThrow();
  await expect(f.client.createNetwork("internal", signal())).rejects.toThrow();
  await expect(f.client.createNetwork("egress", signal())).rejects.toThrow();
  expect(request).toHaveBeenCalledOnce();
});

it("binds the archive to the original helper receipt", async () => {
  server();
  const f = await prepared();
  request.mockClear();
  await expect(
    f.client.wireDesktop(ids.desktop, { ...f.ready, proxyToken: "x".repeat(43) }, signal()),
  ).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
it.each(["invalid-id", "foreign-volume"])(
  "blocks subsequent mutations after a %s create receipt",
  async (fault) => {
    server({ body: Buffer.from(fault === "invalid-id" ? '{"Id":"short"}' : '{"Name":"foreign"}') });
    const f = fixture();
    await expect(
      fault === "invalid-id"
        ? f.client.createNetwork("internal", signal())
        : f.client.createHome(signal()),
    ).rejects.toThrow();
    await expect(f.client.createNetwork("egress", signal())).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
  },
);

it.each(["status", "type", "encoding", "oversize", "utf8", "null", "framing", "incomplete"])(
  "refuses %s mutation reply",
  async (fault) => {
    server({
      status: fault === "status" ? 302 : 201,
      complete: fault !== "incomplete",
      headers: {
        "content-type": fault === "type" ? "text/plain" : "application/json",
        ...(fault === "encoding" ? { "content-encoding": "gzip" } : {}),
        ...(fault === "framing" ? { "content-length": "999" } : {}),
      },
      body:
        fault === "oversize"
          ? Buffer.alloc(4 * 1024 * 1024 + 1)
          : fault === "utf8"
            ? Buffer.from([255])
            : fault === "null"
              ? Buffer.from("null")
              : Buffer.from(JSON.stringify({ Id: ids.internal })),
    });
    await expect(fixture().client.createNetwork("internal", signal())).rejects.toThrow();
  },
);

it.each(["success", "abort", "timeout", "abort-during-drain"])(
  "retains ownership until actual request close on %s",
  async (fault) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const s = server({ manualClose: true, stall: fault === "abort" || fault === "timeout" }),
      f = fixture(),
      controller = new AbortController();
    let settled = false;
    const result = f.client
      .createNetwork("internal", controller.signal)
      .catch((e) => e)
      .finally(() => {
        settled = true;
      });
    await setImmediate();
    if (fault === "abort" || fault === "abort-during-drain") controller.abort();
    if (fault === "timeout") await vi.advanceTimersByTimeAsync(30_000);
    await setImmediate();
    expect(settled).toBe(false);
    s.close();
    const value = await result;
    if (fault === "success") expect(value).toEqual({ Id: ids.internal });
    else expect(value).toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(0);
  },
);
