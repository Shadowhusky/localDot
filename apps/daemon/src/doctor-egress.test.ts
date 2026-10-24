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
    expect(check.detail).toMatch(/home network/i);
  });

  it("reports an ordinary network when the metadata service is unreachable", async () => {
    const check = await egressCheck(async () => false);
    expect(check.ok).toBe(true);
    expect(check.detail).toMatch(/ordinary network/i);
  });

  it("treats a probe error as not-a-datacenter rather than a fault", async () => {
    const check = await egressCheck(async () => {
      throw new Error("no route");
    });
    expect(check).toMatchObject({ ok: true });
    expect(check.detail).toMatch(/ordinary network/i);
  });

  it("forwards the abort signal to the probe", async () => {
    const signal = AbortSignal.abort();
    let seen: AbortSignal | undefined;
    await egressCheck(async (s) => {
      seen = s;
      return false;
    }, signal);
    expect(seen).toBe(signal);
  });

  it("resolves true on connect and false on timeout, error or an aborted signal", async () => {
    const onConnect = fakeSocket();
    const connected = cloudMetadataReachable(undefined, 10, () => onConnect);
    onConnect.emit("connect");
    expect(await connected).toBe(true);

    const onTimeout = fakeSocket();
    const timedOut = cloudMetadataReachable(undefined, 10, () => onTimeout);
    onTimeout.emit("timeout");
    expect(await timedOut).toBe(false);

    const onError = fakeSocket();
    const errored = cloudMetadataReachable(undefined, 10, () => onError);
    onError.emit("error", new Error("ENETUNREACH"));
    expect(await errored).toBe(false);

    let connectAttempts = 0;
    expect(
      await cloudMetadataReachable(AbortSignal.abort(), 10, () => {
        connectAttempts += 1;
        return fakeSocket();
      }),
    ).toBe(false);
    expect(connectAttempts).toBe(0);
  });
});
