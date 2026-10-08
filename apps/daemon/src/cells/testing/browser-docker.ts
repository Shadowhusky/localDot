import { DockerError, type DockerRequest } from "../docker.ts";

type ObjectValue = Record<string, any>;

export class BrowserDocker {
  readonly socketPath = "/test/browser-docker.sock";
  readonly requests: DockerRequest[] = [];
  readonly containers = new Map<string, ObjectValue>();
  readonly networks = new Map<string, ObjectValue>();
  readonly volumes = new Map<string, ObjectValue>();
  before?: (request: DockerRequest) => void | Promise<void>;
  after?: (request: DockerRequest, reply: unknown) => void | Promise<void>;
  next = 1;

  async request<T = undefined>(request: DockerRequest): Promise<T> {
    this.requests.push(structuredClone(request));
    await this.before?.(request);
    const result = this.#request(request);
    await this.after?.(request, result);
    return structuredClone(result) as T;
  }

  #request({ method, path, body, query }: DockerRequest): unknown {
    const data = body as ObjectValue;
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
    const [kind, key, action] = parts;
    const id = () => String(this.next++).padStart(64, "0");
    const missing = () => {
      throw new DockerError(404, "missing", path);
    };
    if (kind === "containers" && key === "json") {
      const volume = JSON.parse(query?.filters ?? "{}").volume?.[0];
      return [...this.containers.values()]
        .filter((entry) => entry.Mounts?.some((mount: ObjectValue) => mount.Name === volume))
        .map((entry) => ({ Id: entry.Id }));
    }
    if (method === "POST" && key === "create") {
      if (kind === "volumes") {
        if (!this.volumes.has(data.Name)) this.volumes.set(data.Name, { ...data });
        return this.volumes.get(data.Name);
      }
      if (kind === "networks") {
        const network = {
          ...data,
          Id: id(),
          Internal: data.Internal === true,
          EnableIPv6: data.EnableIPv6 === true,
          IPAM: {
            Config: [
              {
                Subnet: `172.${30 + this.networks.size}.0.0/16`,
                ...(data.Internal ? {} : { Gateway: "172.31.0.1" }),
              },
            ],
          },
        };
        this.networks.set(network.Id, network);
        return { Id: network.Id };
      }
      if (kind === "containers") {
        const networks: ObjectValue = {};
        for (const [name, entry] of Object.entries(data.NetworkingConfig.EndpointsConfig) as [
          string,
          ObjectValue,
        ][]) {
          const network = [...this.networks.values()].find((candidate) => candidate.Name === name);
          if (!network) return missing();
          networks[name] = {
            NetworkID: network.Id,
            IPAddress: entry.IPAMConfig.IPv4Address,
            GlobalIPv6Address: "",
          };
        }
        const container = {
          Id: id(),
          Name: `/${query?.name}`,
          Config: data,
          HostConfig: data.HostConfig,
          State: { Running: false, Paused: false },
          Mounts: (data.HostConfig.Mounts ?? []).map((mount: ObjectValue) => ({
            Type: mount.Type,
            Name: mount.Source,
            Destination: mount.Target,
          })),
          NetworkSettings: { Networks: networks, Ports: {} },
        };
        this.containers.set(container.Id, container);
        return { Id: container.Id };
      }
    }
    const table =
      kind === "containers" ? this.containers : kind === "networks" ? this.networks : this.volumes;
    const value =
      table.get(key ?? "") ??
      [...table.values()].find((entry) => entry.Name === key || entry.Name === `/${key}`);
    if (!value) return missing();
    if (method === "GET") return value;
    if (method === "DELETE") {
      table.delete(kind === "volumes" ? value.Name : value.Id);
      return undefined;
    }
    if (kind === "containers" && action === "stop") {
      value.State.Running = false;
      return undefined;
    }
    if (kind === "containers" && action === "start") {
      value.State.Running = true;
      if (value.Config.Labels["localdot.role"] === "gate")
        value.NetworkSettings.Ports = {
          "8081/tcp": [{ HostIp: "127.0.0.1", HostPort: "49101" }],
          "8082/tcp": [{ HostIp: "127.0.0.1", HostPort: "49102" }],
        };
      return undefined;
    }
    if (kind === "networks" && action === "connect") {
      const container = this.containers.get(data.Container);
      if (!container) return missing();
      container.NetworkSettings.Networks[value.Name] = {
        NetworkID: value.Id,
        IPAddress: data.EndpointConfig.IPAMConfig.IPv4Address,
        GlobalIPv6Address: "",
      };
      return undefined;
    }
    throw new Error(`unhandled Docker fixture operation ${method} ${path}`);
  }
}
