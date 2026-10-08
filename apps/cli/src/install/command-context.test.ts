import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveCommandContext } from "./command-context.ts";
import { serviceConfigurationId } from "./service-definition.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(managed = true) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "localdot-command-context-")));
  roots.push(home);
  const state = join(home, "install"),
    uid = process.getuid?.() ?? -1;
  const settings = {
    home,
    state,
    uid,
    ownerId: "a".repeat(32),
    port: 4891,
    dockerSocket: join(home, "recorded.sock"),
    userHome: home,
    node: "/recorded/node",
  };
  const release = {
    version: "1.2.3",
    packageSha256: "b".repeat(64),
    manifestSha256: "c".repeat(64),
  };
  const configuration = {
    settings,
    release,
    configuration: serviceConfigurationId(settings, release),
  };
  const owner = { v: 1, id: settings.ownerId, home, state, uid };
  const record = {
    v: 1,
    id: randomUUID(),
    configuration,
    previous: null,
    phase: "stopped",
    jobs: { keyd: { phase: "absent" }, daemon: { phase: "absent" } },
  };
  if (managed) {
    await mkdir(state, { mode: 0o700 });
    await writeFile(join(state, "service-owner.json"), JSON.stringify(owner), { mode: 0o600 });
    await writeFile(join(state, "service-journal.json"), JSON.stringify(record), { mode: 0o600 });
  }
  const controller = new AbortController();
  const env = {
    LOCALDOT_PORT: "invalid ambient value",
    DOCKER_HOST: "tcp://unrelated:2375",
    LOCALDOT_DESKTOP_IMAGE: "unrelated:dev",
  };
  return {
    home,
    state,
    configuration,
    owner,
    record,
    controller,
    env,
    run: () => resolveCommandContext({ home, signal: controller.signal, env }),
  };
}
it("uses recorded routing even with invalid ambient settings and a missing installed executable", async () => {
  const f = await fixture();
  const context = await f.run();
  expect(context.port).toBe(4891);
  expect(context.env.DOCKER_HOST).toBe(`unix://${f.configuration.settings.dockerSocket}`);
  expect(context.env.LOCALDOT_PORT).toBe("4891");
  expect(context.installed).toEqual(f.configuration);
  expect(f.env.LOCALDOT_PORT).toBe("invalid ambient value");
});
it("preserves development behavior only when there is no managed install directory", async () => {
  const f = await fixture(false);
  f.env.LOCALDOT_PORT = "4888";
  const context = await f.run();
  expect(context.port).toBe(4888);
  expect(context.installed).toBeUndefined();
  expect(context.env.DOCKER_HOST).toBe(f.env.DOCKER_HOST);
  f.env.LOCALDOT_PORT = "invalid";
  await expect(f.run()).rejects.toThrow();
});
it.each([
  "missing-record",
  "bad-record",
  "foreign-owner",
  "missing-owner",
  "record-link",
  "bad-mode",
  "wrong-digest",
])("does not fall back to environment after %s", async (kind) => {
  const f = await fixture();
  f.env.LOCALDOT_PORT = "4888";
  const file = join(f.state, "service-journal.json");
  if (kind === "missing-record") await unlink(file);
  if (kind === "bad-record") await writeFile(file, "{");
  if (kind === "foreign-owner")
    await writeFile(
      join(f.state, "service-owner.json"),
      JSON.stringify({ ...f.owner, id: "d".repeat(32) }),
    );
  if (kind === "missing-owner") await unlink(join(f.state, "service-owner.json"));
  if (kind === "record-link") {
    await writeFile(`${file}.saved`, JSON.stringify(f.record), { mode: 0o600 });
    await unlink(file);
    await symlink(`${file}.saved`, file);
  }
  if (kind === "bad-mode") await chmod(f.state, 0o755);
  if (kind === "wrong-digest")
    await writeFile(
      file,
      JSON.stringify({
        ...f.record,
        configuration: { ...f.configuration, configuration: "d".repeat(64) },
      }),
    );
  await expect(f.run()).rejects.toThrow();
});
it("snapshots the environment before asynchronous discovery and observes cancellation", async () => {
  const f = await fixture(false);
  f.env.LOCALDOT_PORT = "4888";
  const pending = f.run();
  f.env.LOCALDOT_PORT = "4999";
  expect((await pending).port).toBe(4888);
  f.controller.abort();
  await expect(f.run()).rejects.toThrow();
});
