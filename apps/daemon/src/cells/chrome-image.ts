import { randomBytes } from "node:crypto";
import { z } from "zod";
import { type DockerClient, DockerError, dockerLogLines } from "./docker.ts";

type Docker = Pick<DockerClient, "request">;

// On a browser image that can have Chrome added to it: it carries install-chrome.sh.
export const CHROME_INSTALL_LABEL = "localdot.chrome-install";
export const CHROME_BASE_LABEL = "localdot.chrome-base";
export const CHROME_VERSION_LABEL = "localdot.chrome-version";
export const CHROME_OWNER_LABEL = "localdot.chrome-owner";
export const CHROME_REPOSITORY = "localdot/browser-chrome";

const CHROME = "/opt/google/chrome/chrome";
const CHROMIUM = "/usr/lib/chromium/chromium";
const PACKAGES = "https://dl.google.com/linux/chrome/deb/dists/stable/main";
const INSTALL_MS = 15 * 60_000;
const COMMIT_MS = 5 * 60_000;
const CHECK_MS = 3 * 60_000;
const VERSION = /^[0-9]+(?:\.[0-9]+){3}$/u;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/u;

export const ChromeImage = z.strictObject({
  image: z.string().regex(IMAGE_ID),
  base: z.string().max(512),
  baseId: z.string().regex(IMAGE_ID),
  version: z.string().regex(VERSION),
  installedAt: z.iso.datetime(),
});
export type ChromeImage = z.infer<typeof ChromeImage>;

export class ChromeInstallError extends Error {}

const INSTALL_FAILURES: Readonly<Record<number, string>> = {
  10: "localDot couldn't reach Google's download server (dl.google.com)",
  11: "Google's signing key didn't match the one localDot expects, so nothing was installed",
  12: "Google's package list couldn't be downloaded or its signature didn't check out, so nothing was installed",
  13: "Chrome's package couldn't be installed",
  14: "Google doesn't publish Chrome for this kind of processor",
};

export interface ImageInspection {
  Id: string;
  Os?: string;
  Architecture?: string;
  RootFS?: { Layers?: string[] };
  Config?: {
    Labels?: Record<string, string> | null;
    User?: string;
    Entrypoint?: string[] | null;
    Cmd?: string[] | null;
    WorkingDir?: string;
    Env?: string[] | null;
  } | null;
}

export async function inspectImage(
  docker: Docker,
  image: string,
): Promise<ImageInspection | undefined> {
  try {
    const found = await docker.request<ImageInspection>({
      method: "GET",
      path: `/images/${encodeURIComponent(image)}/json`,
    });
    return found && typeof found.Id === "string" && IMAGE_ID.test(found.Id) ? found : undefined;
  } catch (error) {
    if (error instanceof DockerError && error.status === 404) return undefined;
    throw error;
  }
}

// Runs a container to its end, hands over its exit status and output, and removes it either way.
async function runOnce<T>(
  docker: Docker,
  name: string,
  config: object,
  timeoutMs: number,
  use: (id: string, code: number, output: readonly string[]) => Promise<T> | T,
): Promise<T> {
  const created = await docker.request<{ Id?: unknown }>({
    method: "POST",
    path: "/containers/create",
    query: { name },
    body: config,
  });
  const id = created?.Id;
  if (typeof id !== "string" || !/^[a-f0-9]{64}$/u.test(id))
    throw new ChromeInstallError("Docker didn't create the container");
  try {
    await docker.request({ method: "POST", path: `/containers/${id}/start` });
    const result = await docker.request<{ StatusCode?: unknown }>({
      method: "POST",
      path: `/containers/${id}/wait`,
      timeoutMs,
    });
    const code = typeof result?.StatusCode === "number" ? result.StatusCode : -1;
    const logs = await docker.request<Buffer>({
      method: "GET",
      path: `/containers/${id}/logs`,
      query: { stdout: "true", stderr: "true", tail: "200" },
      response: "buffer",
    });
    return await use(id, code, Buffer.isBuffer(logs) ? dockerLogLines(logs) : []);
  } finally {
    await docker
      .request({
        method: "DELETE",
        path: `/containers/${id}`,
        query: { force: "true", v: "true" },
      })
      .catch(() => {});
  }
}

export interface BrowserIdentity {
  engine: "chrome" | "chromium";
  version?: string;
}

// Asks the image's own browser binary, the only thing that can't be out of date about itself. It has
// no network, no capabilities and nothing to write to but a scratch folder.
export async function browserIdentity(
  docker: Docker,
  image: string,
  prefix: string,
): Promise<BrowserIdentity | undefined> {
  const name = `${prefix}browser-identity-${randomBytes(6).toString("hex")}`;
  return runOnce(
    docker,
    name,
    {
      Image: image,
      User: "1000:1000",
      Entrypoint: ["/bin/sh", "-c"],
      Cmd: [
        `if [ -x ${CHROME} ]; then ${CHROME} --version; else ${CHROMIUM} --version; fi 2>/dev/null`,
      ],
      Env: ["HOME=/tmp"],
      NetworkDisabled: true,
      HostConfig: {
        NetworkMode: "none",
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        Memory: 256 * 1024 ** 2,
        PidsLimit: 128,
        Tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=16m,mode=1777" },
      },
    },
    CHECK_MS,
    (_id, code, output) => {
      if (code !== 0) return undefined;
      const match = /^(Google Chrome|Chromium) ([0-9.]+)/mu.exec(output.join("\n"));
      if (!match) return undefined;
      return {
        engine: match[1] === "Chromium" ? ("chromium" as const) : ("chrome" as const),
        ...(VERSION.test(match[2] ?? "") ? { version: match[2] } : {}),
      };
    },
  );
}

const sameList = (
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

// The image is exactly the base, layer for layer, with one layer on top: what the install added.
function builtOn(image: ImageInspection, base: ImageInspection): boolean {
  const lower = base.RootFS?.Layers;
  const layers = image.RootFS?.Layers;
  return (
    !!lower?.length &&
    layers?.length === lower.length + 1 &&
    lower.every((layer, index) => layers[index] === layer) &&
    image.Os === base.Os &&
    image.Architecture === base.Architecture
  );
}

export async function verifyChromeImage(
  docker: Docker,
  chrome: ChromeImage,
  base: string,
): Promise<boolean> {
  if (chrome.base !== base) return false;
  const [expected, image] = await Promise.all([
    inspectImage(docker, base),
    inspectImage(docker, chrome.image),
  ]);
  const labels = image?.Config?.Labels;
  return (
    !!expected &&
    !!image &&
    expected.Id === chrome.baseId &&
    image.Id === chrome.image &&
    builtOn(image, expected) &&
    labels?.[CHROME_BASE_LABEL] === base &&
    labels?.[CHROME_VERSION_LABEL] === chrome.version
  );
}

// Proves Chrome starts at all on this machine, under the sandbox the browser cell uses, on a scratch
// profile, before any of the user's sign-ins are handed to it.
async function smokeTest(docker: Docker, image: string, name: string, seccomp: string) {
  const started = await runOnce(
    docker,
    name,
    {
      Image: image,
      User: "1000:1000",
      Entrypoint: [CHROME],
      Cmd: [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--user-data-dir=/tmp/smoke",
        "--dump-dom",
        "about:blank",
      ],
      Env: ["HOME=/tmp"],
      NetworkDisabled: true,
      HostConfig: {
        NetworkMode: "none",
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges", `seccomp=${seccomp}`],
        Init: true,
        Memory: 1024 ** 3,
        PidsLimit: 512,
        ShmSize: 256 * 1024 ** 2,
        Tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=256m,mode=1777" },
      },
    },
    CHECK_MS,
    (_id, code, output) => code === 0 && output.some((line) => line.includes("<html")),
  );
  if (!started) throw new ChromeInstallError("Chrome was installed but didn't start");
}

async function removeStaleHelpers(docker: Docker, stem: string): Promise<void> {
  const found = await docker.request<unknown>({
    method: "GET",
    path: "/containers/json",
    query: { all: "true", filters: JSON.stringify({ name: [stem] }) },
  });
  for (const entry of Array.isArray(found) ? found : []) {
    const { Id: id, Names: names } = entry as { Id?: unknown; Names?: unknown };
    if (
      typeof id === "string" &&
      Array.isArray(names) &&
      names.some((name) => typeof name === "string" && name.startsWith(`/${stem}`))
    )
      await docker
        .request({
          method: "DELETE",
          path: `/containers/${id}`,
          query: { force: "true", v: "true" },
        })
        .catch(() => {});
  }
}

const removeNetwork = (docker: Docker, name: string) =>
  docker
    .request({ method: "DELETE", path: `/networks/${encodeURIComponent(name)}` })
    .catch(() => {});

export interface InstallChromeOptions {
  base: string;
  // Names this install's images and helpers, so another dot on the same engine leaves them alone.
  owner: string;
  prefix: string;
  seccomp: string;
  repository?: string;
}

// A local image made from the released one, with Chrome from Google's signed apt repository in one
// layer on top. The released image is untouched and stays pinned by digest. The container has a network
// of its own, shared with no other container, and only the capabilities apt and dpkg need.
export async function installChromeImage(
  docker: Docker,
  options: InstallChromeOptions,
): Promise<ChromeImage> {
  const { base, owner, prefix, seccomp } = options;
  const source = await inspectImage(docker, base);
  if (!source) throw new ChromeInstallError("The browser image is missing");
  if (source.Config?.Labels?.[CHROME_INSTALL_LABEL] !== "1")
    throw new ChromeInstallError("This version of localDot can't add Chrome. Update it first");
  const stem = `${prefix}chrome-install-${owner}-`;
  const network = `${stem}network`;
  await removeStaleHelpers(docker, stem);
  await removeNetwork(docker, network);
  await docker.request({
    method: "POST",
    path: "/networks/create",
    body: { Name: network, Driver: "bridge", EnableIPv6: false },
  });
  const commit = await runOnce(
    docker,
    `${stem}${randomBytes(6).toString("hex")}`,
    {
      Image: base,
      User: "0:0",
      Entrypoint: ["/bin/sh", "/opt/localdot/install-chrome.sh"],
      HostConfig: {
        NetworkMode: network,
        CapDrop: ["ALL"],
        CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "SETGID", "SETUID"],
        SecurityOpt: ["no-new-privileges"],
        Init: true,
        Memory: 1024 ** 3,
        PidsLimit: 512,
        Tmpfs: { "/tmp": "rw,nosuid,nodev,size=128m,mode=1777" },
        LogConfig: { Type: "json-file", Config: { "max-size": "1m", "max-file": "1" } },
      },
    },
    INSTALL_MS,
    async (id, code, output) => {
      if (code !== 0) {
        if (output.some((line) => line.includes("No space left on device")))
          throw new ChromeInstallError("Docker ran out of disk space installing Chrome");
        throw new ChromeInstallError(INSTALL_FAILURES[code] ?? "Chrome's install didn't finish");
      }
      const version = output
        .map((line) => /^localdot-chrome-version=([0-9.]+)$/u.exec(line)?.[1])
        .find((value) => value && VERSION.test(value));
      if (!version) throw new ChromeInstallError("Chrome's install didn't report its version");
      const committed = await docker.request<{ Id?: unknown }>({
        method: "POST",
        path: "/commit",
        timeoutMs: COMMIT_MS,
        query: {
          container: id,
          repo: options.repository ?? CHROME_REPOSITORY,
          tag: `${owner}-${version}`,
          pause: "false",
          changes: [
            `USER ${source.Config?.User ?? ""}`,
            `WORKDIR ${source.Config?.WorkingDir || "/"}`,
            `ENTRYPOINT ${JSON.stringify(source.Config?.Entrypoint ?? [])}`,
            `LABEL ${CHROME_BASE_LABEL}=${JSON.stringify(base)}`,
            `LABEL ${CHROME_VERSION_LABEL}=${JSON.stringify(version)}`,
            `LABEL ${CHROME_OWNER_LABEL}=${JSON.stringify(owner)}`,
          ].join("\n"),
        },
      });
      if (typeof committed?.Id !== "string" || !IMAGE_ID.test(committed.Id))
        throw new ChromeInstallError("Docker didn't save Chrome's image");
      return { image: committed.Id, version };
    },
  ).finally(() => removeNetwork(docker, network));
  const made = await inspectImage(docker, commit.image);
  if (
    !made ||
    !builtOn(made, source) ||
    made.Config?.User !== source.Config?.User ||
    !sameList(made.Config?.Entrypoint, source.Config?.Entrypoint) ||
    !sameList(made.Config?.Cmd, source.Config?.Cmd) ||
    !sameList(made.Config?.Env, source.Config?.Env)
  ) {
    await removeImage(docker, commit.image);
    throw new ChromeInstallError("Chrome's image isn't what localDot expected");
  }
  try {
    await smokeTest(docker, commit.image, `${stem}${randomBytes(6).toString("hex")}`, seccomp);
  } catch (error) {
    await removeImage(docker, commit.image);
    throw error;
  }
  return {
    image: commit.image,
    base,
    baseId: source.Id,
    version: commit.version,
    installedAt: new Date().toISOString(),
  };
}

export async function removeImage(docker: Docker, image: string): Promise<void> {
  await docker
    .request({ method: "DELETE", path: `/images/${encodeURIComponent(image)}` })
    .catch(() => {});
}

// Chrome images this install no longer uses. Docker refuses one a container still runs on, and that
// one goes next time.
export async function removeChromeImages(
  docker: Docker,
  owner: string,
  keep?: string,
): Promise<void> {
  const found = await docker.request<unknown>({
    method: "GET",
    path: "/images/json",
    query: { filters: JSON.stringify({ label: [`${CHROME_OWNER_LABEL}=${owner}`] }) },
  });
  for (const entry of Array.isArray(found) ? found : []) {
    const id = (entry as { Id?: unknown }).Id;
    if (typeof id === "string" && id !== keep) await removeImage(docker, id);
  }
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

export const majorOf = (version: string) => Number(version.split(".")[0]);

// A hint of whether to install again, not a proof of anything: what is installed is whatever apt
// then verifies against Google's signature.
export async function latestChromeVersion(
  architecture: string,
  fetchText: (url: string) => Promise<string>,
): Promise<string | undefined> {
  if (!/^(?:arm64|amd64)$/u.test(architecture)) return undefined;
  const text = await fetchText(`${PACKAGES}/binary-${architecture}/Packages`);
  const stanza = text
    .split(/\n\n+/u)
    .find((entry) => /^Package: google-chrome-stable$/mu.test(entry));
  const version = stanza && /^Version: ([0-9.]+)-[0-9]+$/mu.exec(stanza)?.[1];
  return version && VERSION.test(version) ? version : undefined;
}
