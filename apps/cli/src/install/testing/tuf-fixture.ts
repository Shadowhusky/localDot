import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { DownloadHTTPError } from "tuf-js/dist/error.js";
import type { TufDownload } from "../tuf-fetcher.ts";

// Synthetic TUF publisher used only in tests. No user signing identity or network participates.
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export function tufFixture(options: { expired?: string; version?: number; target?: string } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = {
    keytype: "ed25519",
    scheme: "ed25519",
    keyval: {
      public: publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex"),
    },
  };
  const id = hash(Buffer.from(canonical(key)));
  const roles = ["root", "timestamp", "snapshot", "targets"];
  const expires = (role: string) =>
    new Date(Date.now() + (options.expired === role ? -86400000 : 86400000)).toISOString();
  const version = options.version ?? 1;
  const metadata = (role: string, extra: object) => {
    const signed = {
      _type: role,
      spec_version: "1.0.31",
      version,
      expires: expires(role),
      ...extra,
    };
    return Buffer.from(
      JSON.stringify({
        signed,
        signatures: [
          {
            keyid: id,
            sig: sign(null, Buffer.from(canonical(signed)), privateKey).toString("hex"),
          },
        ],
      }),
    );
  };
  const bytes = Buffer.from(options.target ?? '{"fixture":"public trust bytes"}');
  const root = metadata("root", {
    consistent_snapshot: false,
    keys: { [id]: key },
    roles: Object.fromEntries(roles.map((role) => [role, { keyids: [id], threshold: 1 }])),
  });
  const target = metadata("targets", {
    targets: { "trusted_root.json": { length: bytes.length, hashes: { sha256: hash(bytes) } } },
  });
  const snapshot = metadata("snapshot", {
    meta: { "targets.json": { version, length: target.length, hashes: { sha256: hash(target) } } },
  });
  const timestamp = metadata("timestamp", {
    meta: {
      "snapshot.json": { version, length: snapshot.length, hashes: { sha256: hash(snapshot) } },
    },
  });
  const files = new Map<string, Buffer>([
    ["/timestamp.json", timestamp],
    ["/snapshot.json", snapshot],
    ["/targets.json", target],
    ["/targets/trusted_root.json", bytes],
  ]);
  const calls: string[] = [];
  const download: TufDownload = async (value) => {
    const path = new URL(value).pathname;
    calls.push(path);
    const result = files.get(path);
    if (!result) throw new DownloadHTTPError("fixture missing", 404);
    return result;
  };
  const rotateRoot = (next: number) => {
    const signed = { ...JSON.parse(root.toString()).signed, version: next };
    return Buffer.from(
      JSON.stringify({
        signed,
        signatures: [
          {
            keyid: id,
            sig: sign(null, Buffer.from(canonical(signed)), privateKey).toString("hex"),
          },
        ],
      }),
    );
  };
  return { seed: root.toString(), files, bytes, calls, download, rotateRoot };
}
