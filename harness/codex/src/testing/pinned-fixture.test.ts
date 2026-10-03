import { existsSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledCodex } from "../install.ts";
import type { CodexProcess } from "../process.ts";
import type { OwnedCodexRoots } from "../roots.ts";
import { codexRelease } from "../version.ts";
import { type PinnedFixture, preparePinnedFixture } from "./pinned-fixture.ts";

// Cleanup semantics need no installed executable. The actual release suite independently
// verifies the installer and runs the real pin. These tests do not launch any process.
vi.mock("../install.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../install.ts")>();
  return {
    ...actual,
    VerifiedCodexInstaller: class {
      readonly installed: InstalledCodex;
      constructor(roots: OwnedCodexRoots) {
        const binDir = join(roots.binRoot, "inert-unit-pin");
        this.installed = {
          version: "0.154.0",
          platform: "darwin-arm64",
          binDir,
          codexBin: join(binDir, "codex"),
          codeModeHostBin: join(binDir, "codex-code-mode-host"),
        };
      }
      async ensureInstalled() {
        return this.installed;
      }
      async verifiedInstallation() {
        return this.installed;
      }
    },
    sha256File: async (path: string) =>
      codexRelease("darwin", "arm64")?.binaries.find(
        (binary) => binary.installedName === basename(path),
      )?.sha256,
  };
});

const fixtures: PinnedFixture[] = [];
const platform = Object.getOwnPropertyDescriptor(process, "platform");
const arch = Object.getOwnPropertyDescriptor(process, "arch");
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  Object.defineProperty(process, "arch", { value: "arm64", configurable: true });
});
afterEach(async () => {
  if (platform) Object.defineProperty(process, "platform", platform);
  if (arch) Object.defineProperty(process, "arch", arch);
  for (const f of fixtures.splice(0)) {
    // Every injected handle is inert; this test owns its exact private root even when the
    // deliberately failing fake owner cannot provide confirmation to the production helper.
    await f.close().catch(() => {});
    rmSync(f.root, { recursive: true, force: true });
  }
});
async function fixture() {
  const f = await preparePinnedFixture("/tmp/inert-never-read-archive.tgz");
  fixtures.push(f);
  return f;
}
function addOwner(f: PinnedFixture, stop: () => Promise<void>) {
  const owner = { stop: vi.fn(stop), closed: Promise.resolve() } as unknown as CodexProcess;
  (f.processes as CodexProcess[]).push(owner);
  return owner;
}
describe("private offline fixture retention", () => {
  it("deletes a successfully retired fixture and returns the same completion", async () => {
    const f = await fixture();
    const owner = addOwner(f, async () => {});
    const completion = f.close();
    expect(f.close()).toBe(completion);
    await completion;
    expect(owner.stop).toHaveBeenCalledOnce();
    expect(existsSync(f.root)).toBe(false);
    expect(f.close()).toBe(completion);
  });
  it("retains the private root on request without skipping confirmed process retirement", async () => {
    const f = await fixture();
    const owner = addOwner(f, async () => {});
    const completion = f.close({ retain: true });
    await completion;
    expect(f.close()).toBe(completion);
    await f.close();
    expect(owner.stop).toHaveBeenCalledOnce();
    expect(existsSync(join(f.roots.home, "config.toml"))).toBe(true);
    expect(f.signal.aborted).toBe(true);
  });
  it("retains a failure and still attempts other independently owned processes", async () => {
    const f = await fixture();
    const healthy = addOwner(f, async () => {});
    const fault = new Error("inert uncertain process retirement");
    const uncertain = addOwner(f, async () => {
      throw fault;
    });
    const completion = f.close();
    await expect(completion).rejects.toThrow(AggregateError);
    expect(f.close()).toBe(completion);
    await expect(f.close()).rejects.toMatchObject({ errors: [fault] });
    expect(healthy.stop).toHaveBeenCalledOnce();
    expect(uncertain.stop).toHaveBeenCalledOnce();
    expect(existsSync(f.root)).toBe(true);
  });
  it("honors retention requested while process retirement is still pending", async () => {
    const f = await fixture();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const owner = addOwner(f, () => pending);
    const completion = f.close();
    expect(f.close({ retain: true })).toBe(completion);
    finish();
    await completion;
    expect(owner.stop).toHaveBeenCalledOnce();
    expect(existsSync(f.root)).toBe(true);
  });
});
