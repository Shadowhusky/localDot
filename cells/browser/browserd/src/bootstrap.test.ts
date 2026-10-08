import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_BOOTSTRAP_BYTES,
  BROWSER_BOOTSTRAP_MS,
  readBrowserBootstrap,
} from "./bootstrap.ts";

const identity = {
  browserCellId: "01J00000000000000000000001",
  parentCellId: "01J00000000000000000000002",
};
const material = {
  v: 1,
  ...identity,
  proxyToken: "c".repeat(43),
  caCertPem: readFileSync(new URL("./testing/bootstrap-ca.pem", import.meta.url), "utf8"),
};
const streams: PassThrough[] = [];
function input() {
  const stream = new PassThrough();
  streams.push(stream);
  return stream;
}

afterEach(() => {
  for (const stream of streams.splice(0)) stream.destroy();
  vi.useRealTimers();
});

describe("private stdin credential handoff", () => {
  it("accepts one bounded fragmented envelope only after EOF", async () => {
    const stream = input();
    let complete = false;
    const pending = readBrowserBootstrap(stream, identity, new AbortController().signal).then(
      (value) => {
        complete = true;
        return value;
      },
    );
    const bytes = Buffer.from(JSON.stringify(material));
    stream.write(bytes.subarray(0, 17));
    stream.write(bytes.subarray(17));
    await Promise.resolve();
    expect(complete).toBe(false);
    stream.end();
    const value = await pending;
    expect(value).toEqual(material);
    expect(Object.isFrozen(value)).toBe(true);
    expect(stream.listenerCount("data")).toBe(0);
    expect(stream.listenerCount("end")).toBe(0);
  });

  it.each([
    { ...material, v: 2 },
    { ...material, browserCellId: identity.parentCellId },
    { ...material, parentCellId: identity.browserCellId },
    { ...material, extra: true },
    { ...material, proxyToken: "short" },
    { ...material, proxyToken: "-".repeat(42) + ":" },
    { ...material, caCertPem: "private-invalid-certificate-canary" },
    { ...material, caCertPem: material.caCertPem + material.caCertPem },
    { ...material, caCertPem: "x".repeat(16385) },
    { ...material, caCertPem: material.caCertPem.replace("CERTIFICATE", "PRIVATE KEY") },
    {
      ...material,
      caCertPem:
        "-----BEGIN CERTIFICATE-----\n" + "x".repeat(256) + "\n-----END CERTIFICATE-----\n",
    },
  ])("refuses invalid or misbound material without echoing it", async (value) => {
    const stream = input();
    const pending = readBrowserBootstrap(stream, identity, new AbortController().signal);
    const refused = expect(pending).rejects.toThrow(/^Browser credential handoff failed$/u);
    stream.end(JSON.stringify(value));
    await refused;
  });

  it.each([
    Buffer.from([0xff]),
    Buffer.from("{"),
    Buffer.from(""),
    Buffer.from(JSON.stringify(material) + "\n{}"),
  ])("refuses malformed framing and UTF-8", async (bytes) => {
    const stream = input();
    const pending = readBrowserBootstrap(stream, identity, new AbortController().signal);
    const refused = expect(pending).rejects.toThrow("handoff failed");
    stream.end(bytes);
    await refused;
  });

  it("rejects overflow before EOF and removes its listeners", async () => {
    const stream = input();
    const pending = readBrowserBootstrap(stream, identity, new AbortController().signal);
    const refused = expect(pending).rejects.toThrow("handoff failed");
    stream.write(Buffer.alloc(BROWSER_BOOTSTRAP_BYTES));
    stream.write(Buffer.from("x"));
    await refused;
    expect(stream.listenerCount("data")).toBe(0);
  });

  it("accepts an envelope at the exact byte bound with JSON whitespace", async () => {
    const stream = input();
    const text = JSON.stringify(material);
    const pending = readBrowserBootstrap(stream, identity, new AbortController().signal);
    stream.end(text + " ".repeat(BROWSER_BOOTSTRAP_BYTES - Buffer.byteLength(text)));
    expect(await pending).toEqual(material);
  });

  it("applies a finite deadline to a well-formed envelope without EOF", async () => {
    vi.useFakeTimers();
    const stream = input();
    const pending = readBrowserBootstrap(stream, identity, new AbortController().signal);
    const refused = expect(pending).rejects.toThrow("handoff failed");
    stream.write(JSON.stringify(material));
    await vi.advanceTimersByTimeAsync(BROWSER_BOOTSTRAP_MS);
    await refused;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses pre-abort and mid-envelope abort without waiting for the deadline", async () => {
    await expect(readBrowserBootstrap(input(), identity, AbortSignal.abort())).rejects.toThrow(
      "handoff failed",
    );
    const stream = input();
    const lifetime = new AbortController();
    const pending = readBrowserBootstrap(stream, identity, lifetime.signal);
    const refused = expect(pending).rejects.toThrow("handoff failed");
    stream.write('{"proxyToken":"private-canary');
    lifetime.abort();
    await refused;
  });

  it("refuses a closed or broken private input pipe", async () => {
    const destroyed = input();
    destroyed.destroy();
    await expect(
      readBrowserBootstrap(destroyed, identity, new AbortController().signal),
    ).rejects.toThrow("handoff failed");
    const stream = input();
    const pending = readBrowserBootstrap(stream, identity, new AbortController().signal);
    const refused = expect(pending).rejects.toThrow("handoff failed");
    stream.destroy(new Error("private pipe detail"));
    await refused;
  });
});
