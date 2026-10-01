import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { DockerClient, dockerSocketPath } from "./cells/docker.ts";
import { imagesFromEnv } from "./cells/images.ts";
import { DOCKER_TESTS, docker, removeAll } from "./cells/testing/docker-cli.ts";
import { runDoctor } from "./doctor.ts";
import { findDockerSocket, hostProbes } from "./doctor-socket.ts";

describe.skipIf(!DOCKER_TESTS)("doctor against Docker Desktop", () => {
  const probeNetwork = `localdot-test-doctor-${randomBytes(4).toString("hex")}`;
  afterAll(() => removeAll({ networks: [probeNetwork] }));

  it("finds isolated gateway mode honoured and both images present", async () => {
    const report = await runDoctor({
      docker: new DockerClient(),
      images: imagesFromEnv(),
      port: 4798,
      probeNetwork,
    });
    const failed = report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
    expect(failed).toEqual([]);
    expect(report.checks.map((c) => c.name)).toEqual([
      "docker-socket",
      "docker-engine",
      "isolated-gateway-mode",
      "image-desktop",
      "image-gate",
      "port-4798",
    ]);
    expect(docker("network", "ls", "--format", "{{.Name}}").split("\n")).not.toContain(
      probeNetwork,
    );
  });

  it("finds the engine through the CLI's context when the default socket is missing", async () => {
    const env = { ...process.env, DOCKER_HOST: undefined };
    const host = execFileSync(
      "docker",
      ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
      { env, encoding: "utf8" },
    ).trim();
    const socket = findDockerSocket(env, {
      ...hostProbes(env),
      exists: (path) => path !== dockerSocketPath({}) && existsSync(path),
    });
    expect(`unix://${socket.path}`).toBe(host);
    expect(socket.source).toMatch(/^the docker context /);
    // The daemon finds the same socket, so the doctor passes it rather than asking for a fix.
    const report = await runDoctor({
      docker: new DockerClient(socket.path),
      socket,
      images: imagesFromEnv(),
      port: 4798,
      probeNetwork,
    });
    expect(report.checks.find((c) => c.name === "docker-socket")).toEqual({
      name: "docker-socket",
      ok: true,
      detail: expect.stringContaining(`${socket.path} (${socket.source}; Engine `),
    });
  });
});
