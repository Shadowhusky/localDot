import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  browserIdentity,
  CHROME_BASE_LABEL,
  CHROME_VERSION_LABEL,
  type ChromeImage,
  ChromeInstallError,
  inspectImage,
  installChromeImage,
  latestChromeVersion,
  removeChromeImages,
  verifyChromeImage,
} from "./chrome-image.ts";
import { DockerClient, dockerSocketPath } from "./docker.ts";
import { DOCKER_TESTS, docker } from "./testing/docker-cli.ts";

// Installs real Chrome from Google into a local image made from the browser image under test. It
// needs the network and about 500 MB of disk; LOCALDOT_CHROME_TEST_REPOSITORY keeps its images apart.
const BASE = process.env.LOCALDOT_BROWSER_IMAGE || "localdot/browser:dev";
const REPOSITORY = process.env.LOCALDOT_CHROME_TEST_REPOSITORY || "localdot-test/browser-chrome";
const SECCOMP = readFileSync(join(import.meta.dirname, "browser-seccomp.json"), "utf8");
const OWNER = `test${randomBytes(4).toString("hex")}`;
const PREFIX = "ldtest-chrome-";

const inImage = (image: string, command: string) =>
  spawnSync(
    "docker",
    ["run", "--rm", "--network", "none", "--entrypoint", "/bin/sh", image, "-c", command],
    { encoding: "utf8" },
  );

describe.skipIf(!DOCKER_TESTS)("Chrome added to a local image from the released one", () => {
  const client = new DockerClient(dockerSocketPath());
  let chrome: ChromeImage;

  afterAll(async () => {
    await removeChromeImages(client, OWNER);
  });

  it("starts from an image with no Chrome in it", async () => {
    expect(inImage(BASE, "test -e /opt/google/chrome/chrome").status).toBe(1);
    expect(await browserIdentity(client, BASE, PREFIX)).toMatchObject({ engine: "chromium" });
  });

  it("installs from Google's signed repository, one layer on the untouched base", async () => {
    const before = await inspectImage(client, BASE);
    chrome = await installChromeImage(client, {
      base: BASE,
      owner: OWNER,
      prefix: PREFIX,
      seccomp: SECCOMP,
      repository: REPOSITORY,
    });
    const base = await inspectImage(client, BASE);
    const image = await inspectImage(client, chrome.image);
    expect(base?.Id).toBe(before?.Id);
    expect(image?.RootFS?.Layers).toEqual([...(base?.RootFS?.Layers ?? []), expect.any(String)]);
    expect(image?.Config?.User).toBe(base?.Config?.User);
    expect(image?.Config?.Entrypoint).toEqual(base?.Config?.Entrypoint);
    expect(image?.Config?.Labels?.[CHROME_BASE_LABEL]).toBe(BASE);
    expect(image?.Config?.Labels?.[CHROME_VERSION_LABEL]).toBe(chrome.version);
    expect(await verifyChromeImage(client, chrome, BASE)).toBe(true);
    expect(await verifyChromeImage(client, chrome, "another/base:tag")).toBe(false);
    const leftovers = docker("ps", "-a", "--filter", `name=${PREFIX}`, "--format", "{{.Names}}");
    expect(leftovers).toBe("");
  }, 900_000);

  it("reports Chrome's version, the one apt's repository lists", async () => {
    expect(await browserIdentity(client, chrome.image, PREFIX)).toEqual({
      engine: "chrome",
      version: chrome.version,
    });
    const listed = await latestChromeVersion(
      docker("image", "inspect", "-f", "{{.Architecture}}", BASE),
      (url) => fetch(url).then((reply) => reply.text()),
    );
    expect(listed).toBe(chrome.version);
  });

  it("keeps Google's key as the only one the package source trusts", () => {
    // Chrome's own package rewrites the source we gave it into this form, with the same key.
    const source = inImage(chrome.image, "cat /etc/apt/sources.list.d/google-chrome.*");
    expect(source.stdout).toMatch(/signed-by: ?\/usr\/share\/keyrings\/google-chrome\.gpg/iu);
    expect(inImage(chrome.image, "ls /var/lib/apt/lists | wc -l").stdout.trim()).toBe("0");
  });

  it("refuses a repository signed by anything other than Google's key", () => {
    const script = [
      "set -e",
      "gpg --homedir /tmp --batch --passphrase '' --quick-gen-key other@example.invalid 2>/dev/null",
      "gpg --homedir /tmp --export other@example.invalid > /usr/share/keyrings/google-chrome.gpg",
      `echo "deb [signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list`,
      "apt-get -o Acquire::http::Proxy=DIRECT -o Acquire::https::Proxy=DIRECT -o APT::Update::Error-Mode=any -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/google-chrome.list -o Dir::Etc::sourceparts=- update",
    ].join("\n");
    const result = spawnSync(
      "docker",
      ["run", "--rm", "--user", "0:0", "--entrypoint", "/bin/sh", BASE, "-c", script],
      { encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(
      /NO_PUBKEY|not signed|signatures? (?:could|were)/iu,
    );
  }, 300_000);

  it("won't add Chrome to an image that doesn't offer it", async () => {
    await expect(
      installChromeImage(client, {
        base: "localdot/gate:dev",
        owner: OWNER,
        prefix: PREFIX,
        seccomp: SECCOMP,
        repository: REPOSITORY,
      }),
    ).rejects.toBeInstanceOf(ChromeInstallError);
  });
});
