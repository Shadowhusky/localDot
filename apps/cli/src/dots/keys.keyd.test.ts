import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SecretBinding } from "../../../../packages/protocol/src/keyd.ts";
import { sealSecret } from "../../../../packages/protocol/src/seal.ts";
import { KeydClient, KeydError } from "../../../daemon/src/keyd/client.ts";
import {
  KEYD_TESTS,
  type KeydProcess,
  startKeyd,
  TEST_KEYD_PORTS,
} from "../../../daemon/src/keyd/testing/keyd-process.ts";

const weather: SecretBinding = {
  id: "weather",
  kind: "http",
  hosts: ["api.example.test"],
  header: "Authorization",
  format: "bearer",
};

let main: KeydProcess;
let work: KeydProcess;

// Two dots' key services side by side, as several dots run them, each on its own ports.
describe.skipIf(!KEYD_TESTS)("copying keys between two dots' real key services", () => {
  beforeAll(async () => {
    const middle = Math.floor((TEST_KEYD_PORTS.from + TEST_KEYD_PORTS.to) / 2);
    main = await startKeyd({ ports: { from: TEST_KEYD_PORTS.from, to: middle } });
    work = await startKeyd({ ports: { from: middle + 1, to: TEST_KEYD_PORTS.to } });
  });
  afterAll(async () => {
    await main?.stop();
    await work?.stop();
  });

  it("copies a sealed key keyd to keyd, then forgets everything a removed dot held", async () => {
    const source = new KeydClient(main.socketPath);
    const destination = new KeydClient(work.socketPath);
    const status = await source.status();
    expect(status.keyCopy).toBe(true);
    expect(status.vaultForget).toBe(true);
    await source.putSecret(weather, await sealSecret(status.sealKey, weather, "not-a-real-key"), {
      label: "Weather",
    });
    expect(await source.copyKeys(work.home)).toEqual({ secrets: 1, logins: 0, skipped: 0 });
    const copied = await destination.secrets();
    expect(copied.map((record) => [record.id, record.hosts, record.metadata?.label])).toEqual([
      ["weather", ["api.example.test"], "Weather"],
    ]);
    await expect(source.copyKeys(main.home)).rejects.toMatchObject({ code: "bad-request" });
    await expect(source.copyKeys(`${work.home}-missing`)).rejects.toBeInstanceOf(KeydError);
    expect(await destination.forgetVault()).toEqual({ secrets: 1, logins: 0 });
    expect(await destination.secrets()).toEqual([]);
  });
});
