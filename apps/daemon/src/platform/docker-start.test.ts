import { expect, it, vi } from "vitest";
import { startDockerDesktop } from "./docker-start.ts";

it("launches Desktop in the background only for its local selected socket", async () => {
  const execute = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
  expect(
    await startDockerDesktop("/Users/me/.docker/run/docker.sock", "darwin", "/Users/me", execute),
  ).toBe(true);
  expect(execute).toHaveBeenCalledWith(
    "/usr/bin/open",
    ["-g", "-a", "Docker"],
    expect.objectContaining({ timeout: 10000 }),
  );
  execute.mockClear();
  for (const socket of ["/run/user/1000/docker.sock", "/tmp/other.sock"])
    expect(await startDockerDesktop(socket, "darwin", "/Users/me", execute)).toBe(false);
  expect(await startDockerDesktop("/var/run/docker.sock", "linux", "/home/me", execute)).toBe(
    false,
  );
  expect(execute).not.toHaveBeenCalled();
});
it("keeps startup available if Desktop cannot be launched", async () => {
  expect(
    await startDockerDesktop(
      "/Users/me/.docker/run/docker.sock",
      "darwin",
      "/Users/me",
      vi.fn().mockRejectedValue(new Error("not installed")),
    ),
  ).toBe(false);
});
