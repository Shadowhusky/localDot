import { afterEach, expect, it, vi } from "vitest";
import { verifyInstalledIsolation } from "./service-isolation.ts";

const mock = vi.hoisted(() => ({
  owner: vi.fn(),
  release: vi.fn(),
  prepare: vi.fn(),
  gateway: vi.fn(),
  client: vi.fn(),
}));
vi.mock("./service-journal.ts", () => ({ verifyServiceOwner: mock.owner }));
vi.mock("./promote-release.ts", () => ({ readInstalledRelease: mock.release }));
vi.mock("./prepare-images.ts", () => ({ prepareReleaseImages: mock.prepare }));
vi.mock("./network-isolation.ts", () => ({ verifyInstalledGateway: mock.gateway }));
vi.mock("./image-client.ts", () => ({ installImageClient: mock.client }));
afterEach(() => {
  for (const fn of Object.values(mock)) fn.mockReset();
});
function fixture() {
  const config = { settings: { state: "/state", dockerSocket: "/recorded/socket" }, release: {} },
    manifest = { version: "fixture" },
    client = { pull: vi.fn(), inspect: vi.fn(), engine: vi.fn() };
  mock.owner.mockResolvedValue(config);
  mock.release.mockResolvedValue({ manifest });
  mock.client.mockReturnValue(client);
  mock.prepare.mockResolvedValue({ engineId: "engine", images: { desktop: "pinned" } });
  mock.gateway.mockResolvedValue({ engineId: "engine" });
  return {
    config,
    manifest,
    client,
    run: () => verifyInstalledIsolation(config as never, new AbortController().signal),
  };
}
it("verifies anchored images before and after the gateway probe without allowing pulls", async () => {
  const f = fixture();
  await f.run();
  expect(mock.client).toHaveBeenCalledWith("/recorded/socket");
  expect(mock.prepare).toHaveBeenCalledTimes(2);
  const restricted = mock.prepare.mock.calls[0]?.[1];
  expect(restricted.inspect).toBe(f.client.inspect);
  await expect(restricted.pull()).rejects.toThrow("missing or changed");
  expect(f.client.pull).not.toHaveBeenCalled();
  expect(mock.prepare.mock.invocationCallOrder[0]).toBeLessThan(
    mock.gateway.mock.invocationCallOrder[0] ?? 0,
  );
  expect(mock.gateway.mock.invocationCallOrder[0]).toBeLessThan(
    mock.prepare.mock.invocationCallOrder[1] ?? 0,
  );
});
it.each(["owner", "release", "images", "gateway", "engine-changed", "images-changed"])(
  "refuses %s failure",
  async (kind) => {
    const f = fixture();
    if (["owner", "release", "gateway"].includes(kind))
      mock[kind as "owner" | "release" | "gateway"].mockRejectedValue(new Error("failed"));
    if (kind === "images") mock.prepare.mockRejectedValue(new Error("failed"));
    if (kind === "engine-changed") mock.gateway.mockResolvedValue({ engineId: "different" });
    if (kind === "images-changed")
      mock.prepare
        .mockResolvedValueOnce({ engineId: "engine", images: { desktop: "pinned" } })
        .mockResolvedValueOnce({ engineId: "engine", images: { desktop: "different" } });
    await expect(f.run()).rejects.toThrow();
  },
);
