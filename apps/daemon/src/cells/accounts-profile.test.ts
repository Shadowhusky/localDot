import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountsProfile } from "./accounts-profile.ts";
import { BrowserDocker } from "./testing/browser-docker.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const LEGACY_A = "localdot-test-profile-01JXYZ0000000000000000000A";
const LEGACY_B = "localdot-test-profile-01JXYZ0000000000000000000B";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "accounts-profile-"));
  homes.push(home);
  const docker = new BrowserDocker();
  const profile = () =>
    new AccountsProfile({ home, docker, prefix: "localdot-test-", image: () => "test/browser" });
  const legacy = (name: string, cookie: string) =>
    docker.volumes.set(name, {
      Name: name,
      Labels: { "localdot.role": "profile", "localdot.cell": name.slice(-26) },
      CreatedAt: `2026-01-0${docker.volumes.size + 1}T00:00:00Z`,
      syntheticCookie: cookie,
    });
  const { volume } = profile();
  const accounts = () => docker.volumes.get(volume);
  const identity = () => JSON.parse(readFileSync(join(home, "accounts-profile.json"), "utf8"));
  return { home, docker, profile, legacy, volume, accounts, identity };
}

describe("the shared sign-in profile", () => {
  it("is one labelled volume that belongs to no computer", async () => {
    const f = fixture();
    await f.profile().ensure();
    await f.profile().ensure();
    expect([...f.docker.volumes.keys()]).toEqual([f.volume]);
    expect(f.volume).toMatch(/^localdot-test-accounts-[0-9a-f]{12}$/u);
    expect(f.accounts()?.Labels).toEqual({
      "localdot.role": "accounts-profile",
      "localdot.accounts-owner": f.identity().owner,
    });
    expect(JSON.stringify(f.accounts()?.Labels)).not.toMatch(/localdot\.(cell|parent)/u);
    expect(f.identity().migration).toBe("done");
  });

  it("is filled once from the starting computer's own old profile, which is left in place", async () => {
    const f = fixture();
    f.legacy(LEGACY_A, "computer-a");
    f.legacy(LEGACY_B, "computer-b");
    await f.profile().ensure([LEGACY_A, LEGACY_B]);
    expect(f.accounts()?.syntheticCookie).toBe("computer-a");
    expect(f.identity()).toMatchObject({ migration: "done", from: LEGACY_A });
    expect(f.docker.volumes.get(LEGACY_A)?.syntheticCookie).toBe("computer-a");
    f.legacy("localdot-test-profile-01JXYZ0000000000000000000C", "later");
    await f.profile().ensure(["localdot-test-profile-01JXYZ0000000000000000000C"]);
    expect(f.accounts()?.syntheticCookie).toBe("computer-a");
    expect(f.docker.containers.size).toBe(0);
  });

  it("falls back to the newest old profile that no container holds", async () => {
    const f = fixture();
    f.legacy(LEGACY_A, "older");
    f.legacy(LEGACY_B, "newer-but-busy");
    f.docker.containers.set("e".repeat(64), {
      Id: "e".repeat(64),
      Mounts: [{ Name: LEGACY_B }],
    });
    await f
      .profile()
      .ensure(["localdot-test-profile-01JXYZ0000000000000000000Z", LEGACY_A, LEGACY_B]);
    expect(f.accounts()?.syntheticCookie).toBe("older");
  });

  it("is named after the install, so another home on the same Docker never opens it", async () => {
    const f = fixture();
    f.legacy(LEGACY_A, "mine");
    await f.profile().ensure([LEGACY_A]);
    const other = mkdtempSync(join(tmpdir(), "accounts-profile-"));
    homes.push(other);
    const second = new AccountsProfile({
      home: other,
      docker: f.docker,
      prefix: "localdot-test-",
      image: () => "test/browser",
    });
    expect(second.volume).not.toBe(f.volume);
    await second.ensure();
    expect(f.docker.volumes.get(second.volume)?.syntheticCookie).toBeUndefined();
    await second.wipe();
    expect(f.accounts()?.syntheticCookie).toBe("mine");
  });

  it("copies with no network, the old profile read-only, as the browser's user", async () => {
    const f = fixture();
    f.legacy(LEGACY_A, "a");
    await f.profile().ensure([LEGACY_A]);
    const create = f.docker.requests.find((request) => request.path === "/containers/create");
    expect(create?.query?.name).toBe(`${f.volume}-copy`);
    expect(create?.body).toMatchObject({
      Image: "test/browser",
      User: "1000:1000",
      NetworkDisabled: true,
      HostConfig: {
        NetworkMode: "none",
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        Mounts: [
          { Type: "volume", Source: LEGACY_A, Target: "/legacy", ReadOnly: true },
          { Type: "volume", Source: f.volume, Target: "/profile" },
        ],
      },
    });
    expect(f.docker.containers.size).toBe(0);
  });

  it("keeps the copy pending after a failed copy and finishes it on the next start", async () => {
    const f = fixture();
    f.legacy(LEGACY_A, "a");
    f.docker.copyStatus = 1;
    await expect(f.profile().ensure([LEGACY_A])).rejects.toThrow("could not be copied");
    expect(f.identity().migration).toBe("pending");
    expect(f.docker.containers.size).toBe(0);
    f.docker.copyStatus = 0;
    await f.profile().ensure([LEGACY_A]);
    expect(f.accounts()?.syntheticCookie).toBe("a");
  });

  it("keeps a volume whose record was lost and never fills it from an old profile", async () => {
    const f = fixture();
    await f.profile().ensure();
    const accounts = f.accounts();
    if (!accounts) throw new Error("fixture volume missing");
    accounts.syntheticCookie = "current";
    rmSync(join(f.home, "accounts-profile.json"));
    f.legacy(LEGACY_A, "old");
    await f.profile().ensure([LEGACY_A]);
    expect(f.accounts()?.syntheticCookie).toBe("current");
  });

  it("refuses a same-named volume that is not this install's", async () => {
    const f = fixture();
    f.docker.volumes.set(f.volume, {
      Name: f.volume,
      Labels: { "localdot.role": "profile" },
    });
    await expect(f.profile().ensure()).rejects.toThrow("cannot be confirmed");
  });

  it("clears everything only when no browser holds it, and starts again empty", async () => {
    const f = fixture();
    await f.profile().ensure();
    const accounts = f.accounts();
    if (!accounts) throw new Error("fixture volume missing");
    accounts.syntheticCookie = "signed-in";
    f.docker.containers.set("d".repeat(64), {
      Id: "d".repeat(64),
      Mounts: [{ Name: f.volume }],
    });
    await expect(f.profile().wipe()).rejects.toThrow("in use");
    expect(f.accounts()?.syntheticCookie).toBe("signed-in");
    f.docker.containers.clear();
    f.legacy(LEGACY_A, "old");
    await f.profile().wipe();
    expect(f.accounts()?.syntheticCookie).toBeUndefined();
    await f.profile().ensure([LEGACY_A]);
    expect(f.accounts()?.syntheticCookie).toBeUndefined();
  });
});
