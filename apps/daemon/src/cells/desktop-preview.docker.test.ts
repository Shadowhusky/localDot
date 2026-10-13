import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  DOCKER_TESTS,
  docker,
  dockerExec,
  dockerLogs,
  dockerOk,
  removeAll,
  waitFor,
} from "./testing/docker-cli.ts";

const name = "localdot-test-desktop-preview";
const image = process.env.LOCALDOT_DESKTOP_IMAGE || "localdot/desktop:dev";
const probe = fileURLToPath(
  new URL("../../../../cells/desktop/tests/preview-native.mjs", import.meta.url),
);

describe.skipIf(!DOCKER_TESTS)("visible local HTTPS development previews", () => {
  afterAll(() => removeAll({ containers: [name] }));
  it("loads local subdomains, fetch and live updates without weakening public TLS", () => {
    removeAll({ containers: [name] });
    docker(
      "run",
      "-d",
      "--name",
      name,
      "--network",
      "none",
      "--shm-size=1g",
      "--tmpfs",
      "/run/localdot-desktop-browser:rw,nosuid,nodev,noexec,size=256m,uid=1000,gid=1000,mode=0700",
      "--add-host",
      "preview-public.test:127.0.0.1",
      "--add-host",
      "localhost.attacker.test:127.0.0.1",
      "-e",
      `LOCALDOT_DESKTOPD_TOKEN=${"p".repeat(43)}`,
      "-e",
      "PASSWORD=preview-fixture-password",
      "-e",
      "PUID=1000",
      "-e",
      "PGID=1000",
      image,
    );
    docker("cp", probe, `${name}:/tmp/preview-native.mjs`);
    waitFor(
      "desktopd",
      () =>
        dockerOk(
          "exec",
          name,
          "curl",
          "-sf",
          "http://127.0.0.1:7700/healthz",
          "-H",
          `Authorization: Bearer ${"p".repeat(43)}`,
        ),
      120_000,
    );
    const result = dockerExec(name, "s6-setuidgid", "abc", "node", "/tmp/preview-native.mjs");
    expect(result.status, result.out + (result.status ? dockerLogs(name) : "")).toBe(0);
    expect(result.out).toContain("PASS visible interaction and screenshot");
    expect(result.out).toContain(
      "PASS public redirect, stopped server, and genuine unsafe-port diagnostics",
    );
    if (process.env.LOCALDOT_PREVIEW_SCREENSHOT)
      docker(
        "cp",
        `${name}:/tmp/local-preview-verified.png`,
        process.env.LOCALDOT_PREVIEW_SCREENSHOT,
      );
  });
});
