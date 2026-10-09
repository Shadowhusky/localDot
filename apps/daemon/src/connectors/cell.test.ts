import { PassThrough } from "node:stream";
import type { LocalServer } from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { DockerClient } from "../cells/docker.ts";
import { type FakeDocker, startFakeDocker } from "../cells/testing/fake-docker.ts";
import { KeydClient } from "../keyd/client.ts";
import { type FakeKeyd, startFakeKeyd } from "../keyd/testing/fake-keyd.ts";
import { AttachTransport, DockerFrames } from "./attach.ts";
import { ConnectorCells } from "./cell.ts";

const frame = (stream: 1 | 2, text: string) => {
  const body = Buffer.from(text);
  const head = Buffer.alloc(8);
  head[0] = stream;
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
};

describe("DockerFrames", () => {
  it("splits stdout and stderr however the bytes arrive", () => {
    const frames = new DockerFrames();
    const seen: [number, string][] = [];
    const all = Buffer.concat([frame(1, "hello"), frame(2, "oops"), frame(1, "!")]);
    for (let i = 0; i < all.length; i += 3)
      frames.push(all.subarray(i, i + 3), (stream, data) => seen.push([stream, data.toString()]));
    expect(seen).toEqual([
      [1, "hello"],
      [2, "oops"],
      [1, "!"],
    ]);
    expect(() => frames.push(Buffer.from([9, 0, 0, 0, 0, 0, 0, 1, 0]), () => {})).toThrow();
  });
});

describe("AttachTransport", () => {
  it("speaks one JSON message per line and keeps the end of stderr", async () => {
    const stream = new PassThrough();
    const written: string[] = [];
    const wire = new PassThrough();
    wire.on("data", (chunk: Buffer) => written.push(chunk.toString()));
    const duplex = Object.assign(stream, {
      write: (chunk: string, cb: (error?: Error | null) => void) => wire.write(chunk, cb),
    });
    const transport = new AttachTransport(duplex as never);
    const messages: unknown[] = [];
    transport.onmessage = (message) => messages.push(message);
    await transport.start();
    stream.emit("data", frame(1, '{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0",'));
    stream.emit("data", frame(2, "npm warn deprecated\n"));
    stream.emit("data", frame(1, '"method":"notifications/x"}\n'));
    expect(messages).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", method: "notifications/x" },
    ]);
    expect(transport.stderr).toBe("npm warn deprecated\n");
    await transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(written.join("")).toBe('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
  });
});

const BRAVE: LocalServer = {
  kind: "local",
  command: "npx",
  args: ["-y", "@brave/brave-search-mcp-server"],
  env: [
    { name: "BRAVE_API_KEY", secret: "connector-brave" },
    { name: "BRAVE_MODE", value: "web" },
  ],
};

describe("ConnectorCells", () => {
  let docker: FakeDocker;
  let keyd: FakeKeyd;
  const reserved = new Set<number>();
  afterEach(async () => {
    await docker?.close();
    await keyd?.close();
    reserved.clear();
  });

  async function cells() {
    docker = await startFakeDocker({
      images: new Set(["localdot/connector:dev", "localdot/gate:dev"]),
    });
    keyd = await startFakeKeyd();
    keyd.records.set("connector-brave", {
      id: "connector-brave",
      kind: "http",
      hosts: ["api.search.brave.com"],
      header: "x-subscription-token",
      format: "raw",
      createdAt: "t",
      updatedAt: "t",
    });
    const attached: PassThrough[] = [];
    let next = 4789;
    const connectorCells = new ConnectorCells({
      docker: new DockerClient(docker.socketPath),
      keyd: new KeydClient(keyd.socketPath, 1000),
      ports: {
        reserve: () => {
          reserved.add(next);
          return next--;
        },
        release: (port) => reserved.delete(port),
      },
      images: { connector: "localdot/connector:dev", gate: "localdot/gate:dev" },
      home: "/tmp/localdot-home",
      attach: async () => {
        const stream = new PassThrough();
        attached.push(stream);
        return { stream, head: Buffer.alloc(0) };
      },
    });
    return { connectorCells, attached };
  }

  it("runs the program walled off: no folder of this Mac, one internal network, stand-ins only", async () => {
    const { connectorCells } = await cells();
    const cell = await connectorCells.open("brave", BRAVE, new AbortController().signal);
    const containers = [...docker.state.containers.values()];
    const program = containers.find((c) => c.body.Labels?.["localdot.role"] === "connector");
    const gate = containers.find((c) => c.body.Labels?.["localdot.role"] === "connector-gate");
    if (!program || !gate) throw new Error("containers missing");
    const body = program.body as unknown as {
      Cmd: string[];
      Env: string[];
      User: string;
      HostConfig: Record<string, unknown>;
      NetworkingConfig: { EndpointsConfig: Record<string, unknown> };
    };
    expect(body.Cmd).toEqual(["npx", "-y", "@brave/brave-search-mcp-server"]);
    expect(body.User).toBe("node");
    for (const key of [
      "Binds",
      "Mounts",
      "Devices",
      "VolumesFrom",
      "Privileged",
      "PidMode",
      "IpcMode",
    ])
      expect(body.HostConfig[key], key).toBeUndefined();
    expect(body.HostConfig).toMatchObject({
      CapDrop: ["ALL"],
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges"],
    });
    expect(Object.keys(body.HostConfig.Tmpfs as object).sort()).toEqual([
      "/home/connector",
      "/tmp",
    ]);
    const networks = Object.keys(body.NetworkingConfig.EndpointsConfig);
    expect(networks).toHaveLength(1);
    const internal = [...docker.state.networks.values()].find((n) => n.Id === networks[0]);
    expect(internal?.Internal).toBe(true);
    const surrogate = keyd.cells.get(cell.cellId)?.surrogates["connector-brave"];
    expect(surrogate).toMatch(/^ld_/);
    expect(body.Env).toContain(`BRAVE_API_KEY=${surrogate}`);
    expect(body.Env).toContain("BRAVE_MODE=web");
    expect(body.Env.find((e) => e.startsWith("HTTPS_PROXY="))).toMatch(
      /^HTTPS_PROXY=http:\/\/connector:[A-Za-z0-9_-]{43}@\d+\.\d+\.\d+\.10:3128$/,
    );
    expect(body.Env.find((e) => e.startsWith("LOCALDOT_CA_PEM="))).toContain("BEGIN CERTIFICATE");
    expect(keyd.cells.get(cell.cellId)?.role).toBe("connector");
    expect((gate.body as unknown as { Env: string[] }).Env).toContain("LD_ROLE=connector");
    expect(program.running).toBe(true);
    await cell.close();
    expect(docker.state.containers.size).toBe(0);
    expect(docker.state.networks.size).toBe(0);
    expect(keyd.cells.has(cell.cellId)).toBe(false);
    expect(reserved.size).toBe(0);
  });

  it("leaves nothing behind when keyd can't open the cell", async () => {
    const { connectorCells } = await cells();
    keyd.failures.set("POST /v1/cells", { status: 500, code: "internal" });
    await expect(
      connectorCells.open("brave", BRAVE, new AbortController().signal),
    ).rejects.toBeDefined();
    expect(docker.state.containers.size).toBe(0);
    expect(docker.state.networks.size).toBe(0);
    expect(reserved.size).toBe(0);
  });
});
