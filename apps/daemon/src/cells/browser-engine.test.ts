import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserEngine, BrowserEngineRefusal, browserEngineOwner } from "./browser-engine.ts";
import { DockerError, type DockerRequest } from "./docker.ts";

const BASE = "ghcr.io/o/localdot-browser@sha256:aaaa";
const BASE_ID = `sha256:${"b".repeat(64)}`;
const CHROME_ID = `sha256:${"c".repeat(64)}`;
const LAYERS = ["sha256:l1", "sha256:l2"];
const VERSION = "157.0.8103.38";
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function logFrame(text: string): Buffer {
  const body = Buffer.from(`${text}\n`);
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

// Enough of Docker for the install: containers run to the exit status given, and a commit makes
// an image one layer above the base.
class Engine {
  readonly requests: DockerRequest[] = [];
  readonly images = new Map<string, Record<string, unknown>>();
  installStatus = 0;
  installVersion = VERSION;
  smokeStatus = 0;
  identity = "Chromium 154.0.8037.57";
  commits = 0;
  #container = new Map<string, string>();
  #next = 1;

  constructor() {
    this.addBase(BASE, BASE_ID, LAYERS);
  }

  addBase(reference: string, id: string, layers: string[]) {
    const image = {
      Id: id,
      Os: "linux",
      Architecture: "arm64",
      RootFS: { Layers: layers },
      Config: {
        User: "1000:1000",
        Entrypoint: ["/usr/local/bin/node", "/opt/localdot/browserd.mjs"],
        Cmd: null,
        Env: ["PATH=/usr/bin"],
        WorkingDir: "/",
        Labels: { "localdot.chrome-install": "1" },
      },
    };
    this.images.set(reference, image);
    this.images.set(id, image);
  }

  async request<T = undefined>(request: DockerRequest): Promise<T> {
    this.requests.push(request);
    return this.#answer(request) as T;
  }

  #answer({ method, path, query, body }: DockerRequest): unknown {
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
    if (path === "/images/json") {
      const owner = JSON.parse(query?.filters ?? "{}").label?.[0]?.split("=")[1];
      return [...this.images.values()].filter(
        (image) =>
          (image.Config as { Labels: Record<string, string> }).Labels?.["localdot.chrome-owner"] ===
          owner,
      );
    }
    if (parts[0] === "images") {
      const image = this.images.get(parts[1] ?? "");
      if (!image) throw new DockerError(404, "no image", path);
      if (method === "DELETE") this.images.delete(parts[1] ?? "");
      return image;
    }
    if (path === "/containers/json") return [];
    if (parts[0] === "networks") return undefined;
    if (path === "/containers/create") {
      const id = String(this.#next++).padStart(64, "0");
      this.#container.set(id, JSON.stringify(body));
      return { Id: id };
    }
    if (path === "/commit") {
      this.commits++;
      const source = this.images.get(BASE_ID) as { RootFS: { Layers: string[] }; Config: object };
      const labels = Object.fromEntries(
        [...(query?.changes ?? "").matchAll(/^LABEL ([^=]+)=(.*)$/gmu)].map((match) => [
          match[1],
          JSON.parse(match[2] ?? ""),
        ]),
      );
      const id =
        this.commits === 1 ? CHROME_ID : `sha256:${String(this.commits).padStart(64, "d")}`;
      this.images.set(id, {
        ...this.images.get(BASE_ID),
        Id: id,
        RootFS: { Layers: [...source.RootFS.Layers, "sha256:chrome"] },
        Config: { ...source.Config, Labels: labels },
      });
      return { Id: id };
    }
    if (parts[0] === "containers") {
      const config = JSON.parse(this.#container.get(parts[1] ?? "") ?? "{}");
      const installing = config.Entrypoint?.[1] === "/opt/localdot/install-chrome.sh";
      const smoke = config.Entrypoint?.[0] === "/opt/google/chrome/chrome";
      if (parts[2] === "wait")
        return {
          StatusCode: installing ? this.installStatus : smoke ? this.smokeStatus : 0,
        };
      if (parts[2] === "logs")
        return logFrame(
          installing
            ? `localdot-chrome-version=${this.installVersion}`
            : smoke
              ? "<html></html>"
              : this.identity,
        );
      return undefined;
    }
    throw new Error(`unhandled ${method} ${path}`);
  }
}

function fixture(options: { lastVersion?: string } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "browser-engine-")));
  homes.push(home);
  const docker = new Engine();
  const accounts = {
    version: options.lastVersion as string | undefined,
    backedUp: false,
    lastVersion: vi.fn(async () => accounts.version),
    backup: vi.fn(async () => {
      accounts.backedUp = true;
    }),
    hasBackup: vi.fn(async () => accounts.backedUp),
    dropBackup: vi.fn(async () => {
      accounts.backedUp = false;
    }),
    restoreBackup: vi.fn(async () => {}),
  };
  const restart = vi.fn();
  const fetchText = vi.fn(async (_url: string) => "");
  const engine = new BrowserEngine({
    home,
    docker,
    prefix: "localdot-test-",
    seccomp: "{}",
    base: () => base.current,
    accounts,
    restart,
    fetchText,
  });
  const base = { current: BASE };
  const record = () => JSON.parse(readFileSync(join(home, "browser-engine.json"), "utf8"));
  const installed = async () => {
    await engine.settled(new AbortController().signal);
    while ((await engine.status()).installing) await new Promise((r) => setTimeout(r, 1));
  };
  return { home, docker, accounts, restart, fetchText, engine, base, record, installed };
}

const ACCEPT = { choice: "chrome", acceptGoogleTerms: true } as const;

describe("which browser the web browser runs", () => {
  it("is Chromium from the pinned image until someone chooses, asking Docker nothing", async () => {
    const f = fixture();
    expect(f.engine.pinned).toBe(true);
    expect(await f.engine.image()).toBe(BASE);
    await f.engine.settled(new AbortController().signal);
    expect(await f.engine.handOverPending()).toBe(false);
    expect(f.docker.requests).toEqual([]);
    expect(await f.engine.status()).toMatchObject({
      engine: "chromium",
      version: "154.0.8037.57",
      choice: null,
      offered: true,
      builtIn: false,
    });
  });

  it("never offers Chrome on an image that can't take it", async () => {
    const f = fixture();
    (f.docker.images.get(BASE) as { Config: { Labels: object } }).Config.Labels = {};
    expect((await f.engine.status()).offered).toBe(false);
  });

  it("names a build that already has Chrome in it, with nothing to choose", async () => {
    const f = fixture();
    f.docker.identity = "Google Chrome 156.0.8078.79 ";
    expect(await f.engine.status()).toMatchObject({
      engine: "chrome",
      version: "156.0.8078.79",
      builtIn: true,
      offered: false,
    });
  });

  it("treats a damaged record as no choice", async () => {
    const f = fixture();
    writeFileSync(join(f.home, "browser-engine.json"), "{");
    expect(f.engine.pinned).toBe(true);
    expect(await f.engine.image()).toBe(BASE);
  });
});

describe("choosing Chrome", () => {
  it("records the acceptance, installs in the background and keeps Chromium until it's ready", async () => {
    const f = fixture({ lastVersion: "154.0.8037.57" });
    await f.engine.choose(ACCEPT);
    expect(f.record().acceptedAt).toMatch(/^20/u);
    expect(statSync(join(f.home, "browser-engine.json")).mode & 0o777).toBe(0o600);
    expect(await f.engine.image()).toBe(BASE);
    await f.installed();
    expect(f.record().chrome.version).toBe(VERSION);
    expect(f.record().handOver).toBe("pending");
    expect(await f.engine.image()).toBe(BASE);
    expect(f.accounts.backup).not.toHaveBeenCalled();
    expect(await f.engine.handOverPending()).toBe(true);
    expect((await f.engine.status()).restartNeeded).toBe(true);
  });

  it("makes the image from the pinned one, as its user, with the install's capabilities only", async () => {
    const f = fixture();
    await f.engine.choose(ACCEPT);
    await f.installed();
    const created = f.docker.requests.filter((request) => request.path === "/containers/create");
    const install = created.find(
      (request) => (request.body as { Image: string; User?: string }).User === "0:0",
    )?.body as { Image: string; HostConfig: Record<string, unknown> };
    expect(install.Image).toBe(BASE);
    const network = `localdot-test-chrome-install-${browserEngineOwner(f.home)}-network`;
    expect(install.HostConfig).toMatchObject({
      NetworkMode: network,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
    });
    const networks = f.docker.requests.filter((request) => request.path.startsWith("/networks"));
    expect(networks.at(-2)?.method).toBe("POST");
    expect(networks.at(-1)).toMatchObject({ method: "DELETE", path: `/networks/${network}` });
    expect(install.HostConfig.Privileged).toBeUndefined();
    const commit = f.docker.requests.find((request) => request.path === "/commit");
    expect(commit?.query?.tag).toBe(`${browserEngineOwner(f.home)}-${VERSION}`);
    expect(commit?.query?.changes).toContain("USER 1000:1000");
    const smoke = created.find((request) => (request.body as { Image: string }).Image === CHROME_ID)
      ?.body as { User: string; HostConfig: Record<string, unknown> };
    expect(smoke.User).toBe("1000:1000");
    expect(smoke.HostConfig).toMatchObject({
      NetworkMode: "none",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges", "seccomp={}"],
    });
  });

  it("backs up the sign-ins before Chrome can open them, and only then uses Chrome", async () => {
    const f = fixture({ lastVersion: "154.0.8037.57" });
    await f.engine.choose(ACCEPT);
    await f.installed();
    await f.engine.handOver();
    expect(f.accounts.backup).toHaveBeenCalledOnce();
    expect(f.record().handOver).toBe("done");
    expect(f.record().backup.version).toBe("154.0.8037.57");
    expect(await f.engine.image()).toBe(CHROME_ID);
    expect(await f.engine.status()).toMatchObject({
      engine: "chrome",
      version: VERSION,
      backup: { version: "154.0.8037.57" },
    });
  });

  it("needs no backup of a profile no browser has opened", async () => {
    const f = fixture();
    await f.engine.choose(ACCEPT);
    await f.installed();
    await f.engine.handOver();
    expect(f.accounts.backup).not.toHaveBeenCalled();
    expect(await f.engine.image()).toBe(CHROME_ID);
    expect((await f.engine.status()).backup).toBeUndefined();
  });

  it("never hands the sign-ins over without a backup", async () => {
    const f = fixture({ lastVersion: "154.0.8037.57" });
    await f.engine.choose(ACCEPT);
    await f.installed();
    f.accounts.backup.mockRejectedValueOnce(
      new Error("Docker doesn't have enough free disk space"),
    );
    await f.engine.handOver();
    expect(await f.engine.image()).toBe(BASE);
    expect(f.record().handOver).toBe("failed");
    const status = await f.engine.status();
    expect(status.engine).toBe("chromium");
    expect(status.problem).toMatch(/enough free disk space/u);
    expect(await f.engine.handOverPending()).toBe(false);
    await f.engine.choose(ACCEPT);
    expect(await f.engine.handOverPending()).toBe(true);
  });

  it("keeps the sign-ins in Chromium if it is newer than Chrome", async () => {
    const f = fixture({ lastVersion: "158.0.1.1" });
    await f.engine.choose(ACCEPT);
    await f.installed();
    await f.engine.handOver();
    expect(f.accounts.backup).not.toHaveBeenCalled();
    expect(await f.engine.image()).toBe(BASE);
    expect((await f.engine.status()).problem).toMatch(/newer browser/u);
  });

  it("restarts a running browser when asked, once Chrome is ready", async () => {
    const f = fixture();
    await f.engine.choose({ ...ACCEPT, restart: true });
    expect(f.restart).not.toHaveBeenCalled();
    await f.installed();
    expect(f.restart).toHaveBeenCalledWith("Switching to Google Chrome.");
  });

  it("leaves a running browser alone otherwise", async () => {
    const f = fixture();
    await f.engine.choose(ACCEPT);
    await f.installed();
    expect(f.restart).not.toHaveBeenCalled();
  });
});

describe("when Chrome can't be installed", () => {
  for (const [code, reason] of [
    [10, /couldn't reach Google/u],
    [11, /signing key/u],
    [12, /signature/u],
    [13, /couldn't be installed/u],
    [14, /kind of processor/u],
  ] as const)
    it(`keeps Chromium and says why (exit ${code})`, async () => {
      const f = fixture();
      f.docker.installStatus = code;
      await f.engine.choose({ ...ACCEPT, restart: true });
      await f.installed();
      expect(await f.engine.image()).toBe(BASE);
      expect(f.docker.commits).toBe(0);
      expect(f.restart).not.toHaveBeenCalled();
      expect(await f.engine.status()).toMatchObject({ engine: "chromium", choice: "chrome" });
      expect((await f.engine.status()).problem).toMatch(reason);
    });

  it("removes an image in which Chrome doesn't start, before it touches the sign-ins", async () => {
    const f = fixture({ lastVersion: "154.0.8037.57" });
    f.docker.smokeStatus = 1;
    await f.engine.choose(ACCEPT);
    await f.installed();
    expect(f.docker.images.has(CHROME_ID)).toBe(false);
    expect(await f.engine.handOverPending()).toBe(false);
    expect((await f.engine.status()).problem).toMatch(/didn't start/u);
  });

  it("doesn't install again on every browser start, but does when asked", async () => {
    const f = fixture();
    f.docker.installStatus = 12;
    await f.engine.choose(ACCEPT);
    await f.installed();
    const attempts = () =>
      f.docker.requests.filter((request) => request.path === "/containers/create").length;
    const before = attempts();
    await f.engine.settled(new AbortController().signal);
    expect(attempts()).toBe(before);
    f.docker.installStatus = 0;
    await f.engine.choose(ACCEPT);
    await f.installed();
    expect((await f.engine.status()).problem).toBeUndefined();
    expect(f.record().chrome.version).toBe(VERSION);
  });
});

describe("a release that pins another browser image", () => {
  const onChrome = async () => {
    const f = fixture({ lastVersion: "154.0.8037.57" });
    await f.engine.choose(ACCEPT);
    await f.installed();
    await f.engine.handOver();
    f.accounts.version = VERSION;
    return f;
  };

  it("stops trusting the old image and installs on the new base", async () => {
    const f = await onChrome();
    const next = "ghcr.io/o/localdot-browser@sha256:bbbb";
    const nextId = `sha256:${"e".repeat(64)}`;
    f.docker.addBase(next, nextId, LAYERS);
    f.base.current = next;
    expect(await f.engine.image()).toBe(next);
    (f.docker.images as Map<string, unknown>).set(BASE_ID, f.docker.images.get(nextId));
    await f.engine.settled(new AbortController().signal);
    await f.installed();
    expect(f.record().handOver).toBe("done");
    expect(f.record().chrome.base).toBe(next);
    expect(f.record().backup.version).toBe("154.0.8037.57");
    expect(f.accounts.backup).toHaveBeenCalledOnce();
  });

  it("notices an image changed under it", async () => {
    const f = await onChrome();
    const image = f.docker.images.get(CHROME_ID) as { RootFS: { Layers: string[] } };
    image.RootFS.Layers = ["sha256:other", ...image.RootFS.Layers.slice(1)];
    expect(await f.engine.image()).toBe(BASE);
    expect((await f.engine.status()).engine).toBe("chromium");
  });
});

describe("Chrome's updates", () => {
  const packages = (version: string) =>
    `Package: google-chrome-beta\nVersion: 999.0.0.1-1\n\nPackage: google-chrome-stable\nVersion: ${version}-1\nArchitecture: arm64\n\n`;

  const onChrome = async () => {
    const f = fixture();
    await f.engine.choose(ACCEPT);
    await f.installed();
    await f.engine.handOver();
    return f;
  };

  it("installs a newer stable version for the next browser start, the running one untouched", async () => {
    const f = await onChrome();
    f.fetchText.mockResolvedValue(packages("158.0.1.1"));
    f.docker.installVersion = "158.0.1.1";
    const signal = new AbortController().signal;
    await f.engine.checkForUpdate(signal);
    await f.installed();
    expect(f.fetchText.mock.calls[0]?.[0]).toBe(
      "https://dl.google.com/linux/chrome/deb/dists/stable/main/binary-arm64/Packages",
    );
    expect(f.record().chrome.version).toBe("158.0.1.1");
    expect(f.record().handOver).toBe("done");
    expect(f.restart).not.toHaveBeenCalled();
    expect(await f.engine.image()).not.toBe(CHROME_ID);
    expect(f.docker.images.has(CHROME_ID)).toBe(false);
  });

  it("does nothing while the installed version is current", async () => {
    const f = await onChrome();
    f.fetchText.mockResolvedValue(packages(VERSION));
    await f.engine.checkForUpdate(new AbortController().signal);
    expect((await f.engine.status()).installing).toBe(false);
    expect(f.docker.commits).toBe(1);
  });

  it("doesn't ask Google anything for someone on Chromium", async () => {
    const f = fixture();
    await f.engine.checkForUpdate(new AbortController().signal);
    await f.engine.choose({ choice: "chromium" });
    await f.engine.checkForUpdate(new AbortController().signal);
    expect(f.fetchText).not.toHaveBeenCalled();
  });
});

describe("going back from Chrome", () => {
  const onChrome = async (chromeRan: boolean) => {
    const f = fixture({ lastVersion: "154.0.8037.57" });
    await f.engine.choose(ACCEPT);
    await f.installed();
    await f.engine.handOver();
    if (chromeRan) f.accounts.version = VERSION;
    return f;
  };

  it("refuses plain Chromium once Chrome has updated the profile, pointing at the backup", async () => {
    const f = await onChrome(true);
    await expect(f.engine.choose({ choice: "chromium" })).rejects.toBeInstanceOf(
      BrowserEngineRefusal,
    );
    await expect(f.engine.choose({ choice: "chromium" })).rejects.toThrow(/backup/u);
    expect(await f.engine.image()).toBe(CHROME_ID);
  });

  it("says to sign out when there's no backup to go back to", async () => {
    const f = await onChrome(true);
    f.accounts.backedUp = false;
    await expect(f.engine.choose({ choice: "chromium" })).rejects.toThrow(/Sign out of all sites/u);
  });

  it("switches directly if Chrome never moved the profile past Chromium", async () => {
    const f = await onChrome(false);
    await f.engine.choose({ choice: "chromium" });
    expect(await f.engine.image()).toBe(BASE);
    expect(f.restart).toHaveBeenCalledWith("Switching to Chromium.");
    expect(f.docker.images.has(CHROME_ID)).toBe(false);
  });

  it("restores the backup, ends on Chromium and frees Chrome's image", async () => {
    const f = await onChrome(true);
    await f.engine.restore();
    expect(f.accounts.restoreBackup).toHaveBeenCalledOnce();
    expect(f.accounts.dropBackup).toHaveBeenCalledOnce();
    expect(f.record()).toEqual({ v: 1, choice: "chromium" });
    expect(await f.engine.image()).toBe(BASE);
    expect(f.docker.images.has(CHROME_ID)).toBe(false);
  });

  it("keeps Chrome in use if the restore fails", async () => {
    const f = await onChrome(true);
    f.accounts.restoreBackup.mockRejectedValueOnce(new Error("disk"));
    await expect(f.engine.restore()).rejects.toThrow("disk");
    expect(await f.engine.image()).toBe(CHROME_ID);
    expect(f.accounts.dropBackup).not.toHaveBeenCalled();
  });

  it("can delete the backup, which ends the way back", async () => {
    const f = await onChrome(true);
    await f.engine.dropBackup();
    expect(f.record().backup).toBeUndefined();
    expect((await f.engine.status()).backup).toBeUndefined();
  });

  it("forgets the backup when the user signs out of every site", async () => {
    const f = await onChrome(true);
    f.accounts.backedUp = false;
    f.engine.signedOut();
    expect(f.record().backup).toBeUndefined();
  });
});
