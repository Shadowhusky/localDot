import { X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { Readable } from "node:stream";
import { ULID_PATTERN } from "@localdot/protocol";
import { z as schema } from "zod";
import type { BrowserRuntimeConfig } from "./runtime-config.ts";

export const BROWSER_BOOTSTRAP_BYTES = 32768;
export const BROWSER_BOOTSTRAP_MS = 15000;

const materialSchema = schema.strictObject({
  v: schema.literal(1),
  browserCellId: schema.string().regex(ULID_PATTERN),
  parentCellId: schema.string().regex(ULID_PATTERN),
  proxyToken: schema.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  caCertPem: schema.string().min(128).max(16384),
});
export type BrowserBootstrapMaterial = Readonly<schema.infer<typeof materialSchema>>;

export class BrowserBootstrapError extends Error {
  constructor() {
    super("Browser credential handoff failed");
  }
}

export function readBrowserBootstrap(
  input: Readable,
  identity: Pick<BrowserRuntimeConfig, "browserCellId" | "parentCellId">,
  signal: AbortSignal,
): Promise<BrowserBootstrapMaterial> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let finished = false;
    const chunks: Buffer[] = [];
    const finish = (material?: BrowserBootstrapMaterial) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      input.pause();
      input.off("data", data);
      input.off("end", end);
      input.off("error", fail);
      input.off("close", fail);
      signal.removeEventListener("abort", fail);
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
      if (material) resolve(material);
      else reject(new BrowserBootstrapError());
    };
    const fail = () => finish();
    const data = (chunk: unknown) => {
      if (!Buffer.isBuffer(chunk)) return fail();
      bytes += chunk.length;
      if (bytes > BROWSER_BOOTSTRAP_BYTES) return fail();
      chunks.push(Buffer.from(chunk));
    };
    const end = () => {
      const buffer = Buffer.concat(chunks, bytes);
      try {
        signal.throwIfAborted();
        const parsed = materialSchema.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)),
        );
        if (
          parsed.browserCellId !== identity.browserCellId ||
          parsed.parentCellId !== identity.parentCellId
        )
          throw new BrowserBootstrapError();
        if (
          !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\r?\n?$/u.test(
            parsed.caCertPem,
          )
        )
          throw new BrowserBootstrapError();
        const certificate = new X509Certificate(parsed.caCertPem);
        if (!certificate.ca) throw new BrowserBootstrapError();
        finish(Object.freeze(parsed));
      } catch {
        fail();
      } finally {
        buffer.fill(0);
      }
    };
    const deadline = setTimeout(fail, BROWSER_BOOTSTRAP_MS);
    input.on("data", data);
    input.once("end", end);
    input.once("error", fail);
    input.once("close", fail);
    signal.addEventListener("abort", fail, { once: true });
    if (signal.aborted || input.destroyed || input.readableEnded) fail();
  });
}

export async function installBrowserBootstrap(
  input: Readable,
  identity: Pick<BrowserRuntimeConfig, "browserCellId" | "parentCellId">,
  signal: AbortSignal,
): Promise<void> {
  try {
    const material = await readBrowserBootstrap(input, identity, signal);
    signal.throwIfAborted();
    if (process.getuid?.() !== 1000) throw new BrowserBootstrapError();
    const directory = await open(
      "/etc/localdot/cell",
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const owner = await directory.stat();
      if (!owner.isDirectory() || owner.uid !== 1000 || (owner.mode & 0o777) !== 0o700)
        throw new BrowserBootstrapError();
      for (const [name, text] of [
        ["ca.pem", material.caCertPem],
        ["proxy-token", `${material.proxyToken}\n`],
      ] as const) {
        signal.throwIfAborted();
        const file = await open(
          `/proc/self/fd/${directory.fd}/${name}`,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        const buffer = Buffer.from(text, "utf8");
        try {
          const state = await file.stat();
          if (
            !state.isFile() ||
            state.uid !== 1000 ||
            state.nlink !== 1 ||
            (state.mode & 0o777) !== 0o600
          )
            throw new BrowserBootstrapError();
          signal.throwIfAborted();
          await file.writeFile(buffer);
          await file.sync();
          signal.throwIfAborted();
        } finally {
          buffer.fill(0);
          await file.close();
        }
      }
    } finally {
      await directory.close();
    }
  } catch {
    throw new BrowserBootstrapError();
  }
}

export async function startBootstrappedBrowser(
  input: Readable,
  identity: Pick<BrowserRuntimeConfig, "browserCellId" | "parentCellId">,
  signal: AbortSignal,
  start: () => Promise<unknown>,
): Promise<void> {
  await installBrowserBootstrap(input, identity, signal);
  if (signal.aborted) throw new BrowserBootstrapError();
  await start();
}
