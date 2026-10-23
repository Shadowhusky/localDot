import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { cloudMetadataReachable, egressCheck } from "./doctor-egress.ts";

function fakeSocket() {
  const socket = new EventEmitter() as EventEmitter & Socket;
  socket.setTimeout = (() => socket) as Socket["setTimeout"];
  socket.destroy = (() => socket) as Socket["destroy"];
  return socket;
}

describe("browser egress advisory", () => {
  it("reports a datacenter host when the metadata service connects, always without failing", async () => {
    const check = await egressCheck(async () => true);
    expect(check).toMatchObject({ name: "browser-egress", ok: true });
    expect(check.detail).toMatch(/datacenter/i);
    expect(check.detail).toMatch(/residential/i);
  });

  it("reports a personal network when the metadata service is unreachable", async () => {
    const check = await egressCheck(async () => false);
    expect(check.ok).toBe(true);
    expect(check.detail).toMatch(/own network/i);
  });

  it("treats a probe error as not-a-datacenter rather than a fault", async () => {
    const check = await egressCheck(async () => {
      throw new Error("no route");
    });
    expect(check).toMatchObject({ ok: true });
    expect(check.detail).toMatch(/own network/i);
  });

  it("resolves true on connect and false on timeout or error", async () => {
    const onConnect = fakeSocket();
    const connected = cloudMetadataReachable(10, () => onConnect);
    onConnect.emit("connect");
    expect(await connected).toBe(true);

    const onTimeout = fakeSocket();
    const timedOut = cloudMetadataReachable(10, () => onTimeout);
    onTimeout.emit("timeout");
    expect(await timedOut).toBe(false);

    const onError = fakeSocket();
    const errored = cloudMetadataReachable(10, () => onError);
    onError.emit("error", new Error("ENETUNREACH"));
    expect(await errored).toBe(false);
  });
});
