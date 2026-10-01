import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeContainer {
  name: string;
  body: {
    Image: string;
    HostConfig: Record<string, unknown>;
    NetworkingConfig?: { EndpointsConfig: Record<string, unknown> };
  };
  running: boolean;
  exitCode: number;
  starts: number;
  ports: Record<string, { HostIp: string; HostPort: string }[]>;
  networks: Record<string, unknown>;
}

export interface FakeNetwork {
  Id: string;
  Name: string;
  Internal: boolean;
  Options: Record<string, string>;
  subnet: string;
}

export interface FakeDockerState {
  version: { Version: string; ApiVersion: string; MinAPIVersion: string; Os: string; Arch: string };
  images: Set<string>;
  networks: Map<string, FakeNetwork>;
  volumes: Set<string>;
  containers: Map<string, FakeContainer>;
  calls: { method: string; path: string; query: URLSearchParams; body: unknown }[];
  nextPort: number;
  // An engine that ignores isolated gateway mode reports a gateway on internal networks.
  gatewayOnInternal: boolean;
  failCreate: Set<string>;
}

export interface FakeDocker {
  socketPath: string;
  state: FakeDockerState;
  close(): Promise<void>;
}

const json = (status: number, body: unknown) => ({ status, body });
const notFound = (what: string) => json(404, { message: `No such ${what}` });
// Docker decodes each path segment, so an encoded name reaches it as the name itself.
const segment = (m: RegExpExecArray, i = 1) => decodeURIComponent(m[i] ?? "");

export async function startFakeDocker(
  overrides: Partial<FakeDockerState> = {},
): Promise<FakeDocker> {
  const state: FakeDockerState = {
    version: {
      Version: "29.2.0",
      ApiVersion: "1.53",
      MinAPIVersion: "1.44",
      Os: "linux",
      Arch: "arm64",
    },
    images: new Set(["localdot/desktop:dev", "localdot/gate:dev"]),
    networks: new Map(),
    volumes: new Set(),
    containers: new Map(),
    calls: [],
    nextPort: 50000,
    gatewayOnInternal: false,
    failCreate: new Set(),
    ...overrides,
  };
  let networkSeq = 20;

  // failCreate holds name prefixes: cell object names carry the (unpredictable) cell id.
  const failsCreate = (name: string) =>
    [...state.failCreate].some((prefix) => name.startsWith(prefix));
  const findNetwork = (ref: string) =>
    state.networks.get(ref) ?? [...state.networks.values()].find((n) => n.Id === ref);
  const containerJson = (c: FakeContainer) => ({
    Id: `id-${c.name}`,
    Name: `/${c.name}`,
    State: { Running: c.running, ExitCode: c.exitCode, Error: "" },
    HostConfig: c.body.HostConfig,
    NetworkSettings: { Ports: c.running ? c.ports : {}, Networks: c.networks },
  });

  function handle(
    method: string,
    path: string,
    query: URLSearchParams,
    body: unknown,
  ): { status: number; body?: unknown } {
    if (method === "GET" && path === "/version") return json(200, state.version);
    const image = /^\/images\/(.+)\/json$/.exec(path);
    if (method === "GET" && image) {
      return state.images.has(segment(image)) ? json(200, { Id: "sha256:img" }) : notFound("image");
    }
    if (method === "POST" && path === "/networks/create") {
      const spec = body as { Name: string; Internal?: boolean; Options?: Record<string, string> };
      if (failsCreate(spec.Name)) return json(500, { message: `refusing to create ${spec.Name}` });
      networkSeq += 1;
      const net: FakeNetwork = {
        Id: `net-${networkSeq}`,
        Name: spec.Name,
        Internal: spec.Internal ?? false,
        Options: spec.Options ?? {},
        subnet: `172.${networkSeq}.0.0/16`,
      };
      state.networks.set(net.Name, net);
      return json(201, { Id: net.Id, Warning: "" });
    }
    const network = /^\/networks\/([^/]+)$/.exec(path);
    if (network) {
      const net = findNetwork(segment(network));
      if (!net) return notFound("network");
      if (method === "DELETE") {
        state.networks.delete(net.Name);
        return { status: 204 };
      }
      const isolated =
        net.Internal && net.Options["com.docker.network.bridge.gateway_mode_ipv4"] === "isolated";
      const gateway =
        isolated && !state.gatewayOnInternal ? {} : { Gateway: net.subnet.replace(/0\/16$/, "1") };
      return json(200, {
        Id: net.Id,
        Name: net.Name,
        Internal: net.Internal,
        Options: net.Options,
        IPAM: { Config: [{ Subnet: net.subnet, ...gateway }] },
      });
    }
    const connect = /^\/networks\/([^/]+)\/connect$/.exec(path);
    if (method === "POST" && connect) {
      const net = findNetwork(segment(connect));
      const { Container, EndpointConfig } = body as { Container: string; EndpointConfig?: unknown };
      const c = state.containers.get(Container);
      if (!net || !c) return notFound("network or container");
      if (net.Name in c.networks) return json(403, { message: "endpoint already exists" });
      c.networks[net.Name] = EndpointConfig ?? {};
      return { status: 200 };
    }
    if (method === "POST" && path === "/volumes/create") {
      state.volumes.add((body as { Name: string }).Name);
      return json(201, { Name: (body as { Name: string }).Name });
    }
    const volume = /^\/volumes\/([^/]+)$/.exec(path);
    if (method === "DELETE" && volume) {
      return state.volumes.delete(segment(volume)) ? { status: 204 } : notFound("volume");
    }
    if (method === "POST" && path === "/containers/create") {
      const name = query.get("name") ?? "";
      if (failsCreate(name)) return json(500, { message: `refusing to create ${name}` });
      const spec = body as FakeContainer["body"];
      const networks: Record<string, unknown> = {};
      for (const [net, cfg] of Object.entries(spec.NetworkingConfig?.EndpointsConfig ?? {})) {
        networks[net] = cfg;
      }
      state.containers.set(name, {
        name,
        body: spec,
        running: false,
        exitCode: 0,
        starts: 0,
        ports: {},
        networks,
      });
      return json(201, { Id: `id-${name}`, Warnings: [] });
    }
    const action = /^\/containers\/([^/]+)\/(json|start|stop)$/.exec(path);
    if (action) {
      const c = state.containers.get(segment(action));
      if (!c) return notFound("container");
      if (action[2] === "json") return json(200, containerJson(c));
      if (action[2] === "start") {
        if (c.running) return { status: 304 };
        c.starts += 1;
        c.running = true;
        c.ports = {};
        const bindings = (c.body.HostConfig.PortBindings as Record<string, unknown>) ?? {};
        for (const port of Object.keys(bindings)) {
          c.ports[port] = [{ HostIp: "127.0.0.1", HostPort: String(state.nextPort++) }];
        }
        return { status: 204 };
      }
      if (!c.running) return { status: 304 };
      c.running = false;
      c.exitCode = 0;
      return { status: 204 };
    }
    const container = /^\/containers\/([^/]+)$/.exec(path);
    if (method === "DELETE" && container) {
      return state.containers.delete(segment(container)) ? { status: 204 } : notFound("container");
    }
    return json(404, { message: `fake docker: no route ${method} ${path}` });
  }

  const dir = mkdtempSync(join(tmpdir(), "ld-fake-docker-"));
  const socketPath = join(dir, "d.sock");
  const server: Server = createServer((req, res) => {
    let text = "";
    req.on("data", (c) => {
      text += c;
    });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://docker");
      const path = url.pathname.replace(/^\/v1\.\d+/, "");
      const body = text ? JSON.parse(text) : undefined;
      state.calls.push({ method: req.method ?? "", path, query: url.searchParams, body });
      const out = handle(req.method ?? "", path, url.searchParams, body);
      if (out.body === undefined) {
        res.writeHead(out.status);
        res.end();
        return;
      }
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(socketPath, r));
  return {
    socketPath,
    state,
    close: () =>
      new Promise<void>((r) =>
        server.close(() => {
          rmSync(dir, { recursive: true, force: true });
          r();
        }),
      ),
  };
}
