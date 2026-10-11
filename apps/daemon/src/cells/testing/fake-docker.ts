import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareApiVersions } from "../docker.ts";

export interface FakeContainer {
  name: string;
  // Defaults to `id-<name>` as created; it stays the same through a rename.
  id?: string;
  // The image ID the container was created from.
  image?: string;
  body: {
    Image: string;
    Labels?: Record<string, string>;
    HostConfig: Record<string, unknown>;
    NetworkingConfig?: { EndpointsConfig: Record<string, unknown> };
  };
  running: boolean;
  paused: boolean;
  files: Map<string, Buffer>;
  changes?: { Path: string; Kind: number }[];
  exitCode: number;
  starts: number;
  ports: Record<string, { HostIp: string; HostPort: string }[]>;
  networks: Record<string, unknown>;
}

export interface FakeNetwork {
  Id: string;
  Name: string;
  Internal: boolean;
  Driver: string;
  EnableIPv6: boolean;
  Options: Record<string, string>;
  subnet: string;
  created: string;
  Labels?: Record<string, string>;
}

export interface FakeDockerState {
  version: { Version: string; ApiVersion: string; MinAPIVersion: string; Os: string; Arch: string };
  images: Set<string>;
  networks: Map<string, FakeNetwork>;
  volumes: Set<string>;
  volumeLabels: Map<string, Record<string, string>>;
  containers: Map<string, FakeContainer>;
  calls: { method: string; path: string; query: URLSearchParams; body: unknown }[];
  nextPort: number;
  // An engine that ignores isolated gateway mode reports a gateway on internal networks.
  gatewayOnInternal: boolean;
  failCreate: Set<string>;
  // "METHOD /path" prefixes answered with a 500, so a test can fail a start, a connect or an
  // inspect of an object whose cell id it does not know yet.
  failRequests: Set<string>;
  // One-shot response loss after the matching operation has taken effect.
  loseReplies: Set<string>;
  // A request whose "METHOD path" is held here is answered only once the promise settles, the way
  // a slow Docker operation keeps the caller waiting; the reply reflects the state at that moment.
  holds: Map<string, Promise<void>>;
  // Rewrites a network inspect reply, for an engine that answers in a shape localdot doesn't expect.
  networkInspect?: (reply: Record<string, unknown>) => unknown;
  imageInspect?: (reference: string, reply: Record<string, unknown>) => unknown;
  // The image ID a reference names now; a rebuilt image moves its tag to a new ID.
  imageIds: Map<string, string>;
  // An image's own labels, by reference; the gate image built from this tree says it captures.
  imageLabels: Map<string, Record<string, string>>;
  // Extra /info fields, such as the limits a native engine supports.
  info?: Record<string, unknown>;
}

export interface FakeDocker {
  socketPath: string;
  state: FakeDockerState;
  close(): Promise<void>;
}

const json = (status: number, body: unknown) => ({ status, body });
const notFound = (what: string) => json(404, { message: `No such ${what}` });
// Docker Desktop 4.60 answers /version at a refused API version with this, and no message.
const refusedVersion = json(400, {
  Platform: { Name: "Docker Desktop 4.60.0 (218231)" },
  Version: "",
  ApiVersion: "",
  Os: "",
  Arch: "",
});
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
    volumeLabels: new Map(),
    containers: new Map(),
    calls: [],
    nextPort: 50000,
    gatewayOnInternal: false,
    failCreate: new Set(),
    failRequests: new Set(),
    loseReplies: new Set(),
    holds: new Map(),
    imageIds: new Map(),
    imageLabels: new Map([["localdot/gate:dev", { "localdot.capture": "1" }]]),
    ...overrides,
  };
  let networkSeq = 20;

  // failCreate holds name prefixes: cell object names carry the (unpredictable) cell id.
  const failsCreate = (name: string) =>
    [...state.failCreate].some((prefix) => name.startsWith(prefix));
  const findNetwork = (ref: string) =>
    state.networks.get(ref) ?? [...state.networks.values()].find((n) => n.Id === ref);
  const mounts = (c: FakeContainer) =>
    ((c.body.HostConfig.Mounts as { Source?: string }[] | undefined) ?? []).map((m) => m.Source);
  const DEFAULT_IMAGE = `sha256:${"a".repeat(64)}`;
  const imageId = (reference: string) => state.imageIds.get(reference) ?? DEFAULT_IMAGE;
  const idOf = (c: FakeContainer) => c.id ?? `id-${c.name}`;
  const containerJson = (c: FakeContainer) => ({
    Id: idOf(c),
    Name: `/${c.name}`,
    Image: c.image ?? imageId(c.body.Image),
    State: { Running: c.running, Paused: c.paused, ExitCode: c.exitCode, Error: "" },
    HostConfig: c.body.HostConfig,
    Config: { Image: c.body.Image, Labels: c.body.Labels ?? {} },
    NetworkSettings: { Ports: c.running ? c.ports : {}, Networks: c.networks },
  });

  // The engine refuses a request at an API version outside its range; unversioned paths always pass.
  function refusal(api: string, path: string): { status: number; body?: unknown } | undefined {
    const { MinAPIVersion: min, ApiVersion: max } = state.version;
    const tooOld = compareApiVersions(api, min) < 0;
    if (!tooOld && compareApiVersions(api, max) <= 0) return undefined;
    if (path === "/version") return refusedVersion;
    return json(400, {
      message: tooOld
        ? `client version ${api} is too old. Minimum supported API version is ${min}, please upgrade your client to a newer version`
        : `client version ${api} is too new. Maximum supported API version is ${max}`,
    });
  }

  const findContainer = (ref: string) =>
    state.containers.get(ref) ?? [...state.containers.values()].find((c) => idOf(c) === ref);

  function handle(
    method: string,
    path: string,
    query: URLSearchParams,
    body: unknown,
    raw: Buffer,
  ): { status: number; body?: unknown } {
    if (method === "GET" && path === "/version") return json(200, state.version);
    if (method === "GET" && path === "/info")
      return json(200, {
        ID: "fake-docker-engine",
        OSType: state.version.Os,
        Architecture: state.version.Arch,
        ...state.info,
      });
    if (method === "POST" && path === "/commit") {
      const c = findContainer(query.get("container") ?? "");
      if (!c) return notFound("container");
      const id = `sha256:${(state.images.size + 1).toString(16).padStart(64, "0")}`;
      state.images.add(id);
      state.imageIds.set(id, id);
      state.imageLabels.set(id, (body as { Labels: Record<string, string> }).Labels);
      return json(201, { Id: id });
    }
    const changes = /^\/containers\/([^/]+)\/changes$/.exec(path);
    if (method === "GET" && changes) {
      const c = findContainer(segment(changes));
      return c ? json(200, c.changes ?? []) : notFound("container");
    }
    const image = /^\/images\/(.+)\/json$/.exec(path);
    if (method === "GET" && image) {
      const reference = segment(image);
      const reply = {
        Id: imageId(reference),
        Os: "linux",
        Architecture: state.version.Arch,
        RepoDigests: reference.includes("@") ? [reference] : [],
        Config: { Labels: state.imageLabels.get(reference) ?? null },
      };
      return state.images.has(reference)
        ? json(200, state.imageInspect ? state.imageInspect(reference, reply) : reply)
        : notFound("image");
    }
    if (method === "POST" && path === "/networks/create") {
      const spec = body as {
        Name: string;
        Internal?: boolean;
        Driver?: string;
        EnableIPv6?: boolean;
        Options?: Record<string, string>;
        Labels?: Record<string, string>;
      };
      if (failsCreate(spec.Name)) return json(500, { message: `refusing to create ${spec.Name}` });
      if (state.networks.has(spec.Name)) {
        return json(409, { message: `network with name ${spec.Name} already exists` });
      }
      networkSeq += 1;
      const net: FakeNetwork = {
        Id: networkSeq.toString(16).padStart(64, "0"),
        Name: spec.Name,
        Labels: spec.Labels,
        Internal: spec.Internal ?? false,
        Driver: spec.Driver ?? "bridge",
        EnableIPv6: spec.EnableIPv6 ?? false,
        Options: spec.Options ?? {},
        subnet: `172.${networkSeq}.0.0/16`,
        created: new Date().toISOString(),
      };
      state.networks.set(net.Name, net);
      return json(201, { Id: net.Id, Warning: "" });
    }
    if (method === "GET" && path === "/networks") {
      // Docker's name filter matches any part of the name.
      const filters = JSON.parse(query.get("filters") ?? "{}"),
        names: string[] = filters.name ?? [];
      const listed = [...state.networks.values()].filter(
        (n) =>
          (names.length === 0 || names.some((name) => n.Name.includes(name))) &&
          (!filters.label?.length ||
            filters.label.every((label: string) => {
              const [key, value] = label.split("=");
              return (
                !!key &&
                (value === undefined ? n.Labels?.[key] !== undefined : n.Labels?.[key] === value)
              );
            })),
      );
      return json(
        200,
        listed.map((n) => ({ Id: n.Id, Name: n.Name, Created: n.created, Internal: n.Internal })),
      );
    }
    const network = /^\/networks\/([^/]+)$/.exec(path);
    if (network) {
      const net = findNetwork(segment(network));
      if (!net) return notFound("network");
      if (method === "DELETE") {
        const attached = [...state.containers.values()].some(
          (c) => c.running && net.Name in c.networks,
        );
        if (attached) {
          return json(403, {
            message: `error while removing network: network ${net.Name} id ${net.Id} has active endpoints`,
          });
        }
        state.networks.delete(net.Name);
        return { status: 204 };
      }
      const isolated =
        net.Internal && net.Options["com.docker.network.bridge.gateway_mode_ipv4"] === "isolated";
      const gateway =
        isolated && !state.gatewayOnInternal ? {} : { Gateway: net.subnet.replace(/0\/16$/, "1") };
      const reply = {
        Id: net.Id,
        Name: net.Name,
        Labels: net.Labels,
        Created: net.created,
        Internal: net.Internal,
        Driver: net.Driver,
        EnableIPv6: net.EnableIPv6,
        Containers: Object.fromEntries(
          [...state.containers.entries()]
            .filter(([, c]) => net.Name in c.networks)
            .map(([name]) => [name, {}]),
        ),
        Options: net.Options,
        IPAM: { Config: [{ Subnet: net.subnet, ...gateway }] },
      };
      return json(200, state.networkInspect ? state.networkInspect(reply) : reply);
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
      const spec = body as { Name: string; Labels?: Record<string, string> };
      if (!state.volumes.has(spec.Name)) {
        state.volumes.add(spec.Name);
        state.volumeLabels.set(spec.Name, spec.Labels ?? {});
      }
      return json(201, { Name: spec.Name, Labels: state.volumeLabels.get(spec.Name) });
    }
    const volume = /^\/volumes\/([^/]+)$/.exec(path);
    if (method === "GET" && volume) {
      const name = segment(volume);
      return state.volumes.has(name)
        ? json(200, { Name: name, Labels: state.volumeLabels.get(name) ?? {} })
        : notFound("volume");
    }
    if (method === "DELETE" && volume) {
      const name = segment(volume);
      if (!state.volumes.has(name)) return notFound("volume");
      // Docker refuses an in-use volume even with force=true, and a stopped container uses it too.
      const user = [...state.containers.values()].find((c) => mounts(c).includes(name));
      if (user)
        return json(409, { message: `remove ${name}: volume is in use - [id-${user.name}]` });
      state.volumes.delete(name);
      return { status: 204 };
    }
    if (method === "GET" && path === "/containers/json") {
      const filters = JSON.parse(query.get("filters") ?? "{}");
      const containers = [...state.containers.values()].filter(
        (c) =>
          (!filters.volume?.length ||
            filters.volume.some((name: string) => mounts(c).includes(name))) &&
          (!filters.label?.length ||
            filters.label.every((label: string) => {
              const [key, value] = label.split("=");
              return (
                !!key &&
                (value === undefined
                  ? c.body.Labels?.[key] !== undefined
                  : c.body.Labels?.[key] === value)
              );
            })),
      );
      return json(
        200,
        containers.map((c) => ({
          Id: idOf(c),
          Names: [`/${c.name}`],
          Labels: c.body.Labels ?? {},
        })),
      );
    }
    if (method === "POST" && path === "/containers/create") {
      const name = query.get("name") ?? "";
      if (failsCreate(name)) return json(500, { message: `refusing to create ${name}` });
      if (state.containers.has(name)) {
        return json(409, {
          message: `Conflict. The container name "/${name}" is already in use by container "id-${name}". You have to remove (or rename) that container to be able to reuse that name.`,
        });
      }
      const spec = body as FakeContainer["body"];
      const networks: Record<string, unknown> = {};
      for (const [net, cfg] of Object.entries(spec.NetworkingConfig?.EndpointsConfig ?? {})) {
        networks[net] = cfg;
      }
      state.containers.set(name, {
        name,
        id: `id-${name}`,
        image: imageId(spec.Image),
        body: spec,
        running: false,
        paused: false,
        files: new Map(),
        exitCode: 0,
        starts: 0,
        ports: {},
        networks,
      });
      return json(201, { Id: `id-${name}`, Warnings: [] });
    }
    const rename = /^\/containers\/([^/]+)\/rename$/.exec(path);
    if (method === "POST" && rename) {
      const c = findContainer(segment(rename));
      if (!c) return notFound("container");
      const name = query.get("name") ?? "";
      if (state.containers.has(name))
        return json(409, { message: `Conflict. The container name "/${name}" is already in use` });
      state.containers.delete(c.name);
      c.id = idOf(c);
      c.name = name;
      state.containers.set(name, c);
      return { status: 204 };
    }
    const archive = /^\/containers\/([^/]+)\/archive$/.exec(path);
    if (method === "PUT" && archive) {
      const c = state.containers.get(segment(archive));
      if (!c) return notFound("container");
      for (const [name, data] of untar(raw)) c.files.set(`${query.get("path")}/${name}`, data);
      return { status: 200 };
    }
    const action = /^\/containers\/([^/]+)\/(json|start|stop|pause|unpause)$/.exec(path);
    if (action) {
      const c = findContainer(segment(action));
      if (!c) return notFound("container");
      if (action[2] === "json") return json(200, containerJson(c));
      if (action[2] === "pause" || action[2] === "unpause") {
        const pausing = action[2] === "pause";
        // Verified on Engine 29.2: unpause of a non-paused container is a 500, even if stopped.
        if (!pausing && !c.paused)
          return json(500, { message: `container ${c.name} is not paused` });
        if (!c.running || c.paused === pausing) {
          return json(409, { message: `container ${c.name} cannot ${action[2]} now` });
        }
        c.paused = pausing;
        return { status: 204 };
      }
      if (action[2] === "start") {
        if (c.paused)
          return json(409, { message: "cannot start a paused container, try unpause instead" });
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
      c.paused = false;
      c.exitCode = 0;
      return { status: 204 };
    }
    // A one-shot container (the desktop's link helper) has run to its end by the time it is waited on.
    const wait = /^\/containers\/([^/]+)\/wait$/.exec(path);
    if (method === "POST" && wait) {
      const c = findContainer(segment(wait));
      if (!c) return notFound("container");
      c.running = false;
      return json(200, { StatusCode: c.exitCode });
    }
    const container = /^\/containers\/([^/]+)$/.exec(path);
    if (method === "DELETE" && container) {
      const c = findContainer(segment(container));
      if (!c) return notFound("container");
      if (c.running && query.get("force") !== "true") {
        return json(409, {
          message: `You cannot remove a running container id-${c.name}. Stop the container before attempting removal or force remove`,
        });
      }
      state.containers.delete(c.name);
      return { status: 204 };
    }
    return json(404, { message: `fake docker: no route ${method} ${path}` });
  }

  const dir = mkdtempSync(join(tmpdir(), "ld-fake-docker-"));
  const socketPath = join(dir, "d.sock");
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      chunks.push(c);
    });
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://docker");
      const api = /^\/v(\d+\.\d+)\//.exec(url.pathname)?.[1];
      const path = url.pathname.replace(/^\/v\d+\.\d+/, "");
      const raw = Buffer.concat(chunks);
      const isJson = (req.headers["content-type"] ?? "").includes("application/json");
      const body = isJson && raw.length > 0 ? JSON.parse(raw.toString("utf8")) : undefined;
      state.calls.push({ method: req.method ?? "", path, query: url.searchParams, body });
      await state.holds.get(`${req.method} ${path}`);
      const request = `${req.method} ${path}`;
      const failed = [...state.failRequests].some((prefix) => request.startsWith(prefix));
      const out =
        (failed ? json(500, { message: `fake docker: refusing ${request}` }) : undefined) ??
        (api === undefined ? undefined : refusal(api, path)) ??
        handle(req.method ?? "", path, url.searchParams, body, raw);
      const lost = [...state.loseReplies].find((prefix) => request.startsWith(prefix));
      if (lost) {
        state.loseReplies.delete(lost);
        res.destroy();
        return;
      }
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

// Only the flat regular-file ustar archives produced by tar.ts are used by these tests.
function untar(archive: Buffer): [string, Buffer][] {
  const files: [string, Buffer][] = [];
  for (let at = 0; at + 512 <= archive.length; ) {
    const header = archive.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const field = (from: number, to: number) =>
      header.subarray(from, to).toString("ascii").replace(/\0.*$/s, "");
    const size = Number.parseInt(field(124, 136), 8);
    files.push([field(0, 100), Buffer.from(archive.subarray(at + 512, at + 512 + size))]);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
