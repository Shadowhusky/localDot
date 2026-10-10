import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DistributionAcceptance,
  DistributionManifest,
} from "../../packages/protocol/src/distribution.ts";

// This is a release-gate check, not evidence authentication. A protected publisher must review
// the actual evidence and its producer before accepting these records. No self-attested flag
// can make a candidate executable by the installer.
export function verifyAcceptance(manifestBytes, records) {
  const manifest = DistributionManifest.parse(JSON.parse(manifestBytes.toString("utf8")));
  const digest = createHash("sha256").update(manifestBytes).digest("hex");
  const required = Object.keys(manifest.bundles).flatMap((platform) =>
    platform.startsWith("darwin")
      ? [`${platform}:macos`]
      : [`${platform}:linux`, `${platform}:windows-wsl2`],
  );
  const seen = new Set();
  for (const raw of records) {
    const record = DistributionAcceptance.parse(raw);
    const key = `${record.platform}:${record.host}`;
    if (seen.has(key) || !required.includes(key))
      throw new Error(`Unexpected or repeated acceptance: ${key}`);
    if (
      record.version !== manifest.version ||
      record.commit !== manifest.commit ||
      record.manifestSha256 !== digest
    )
      throw new Error("Acceptance belongs to a different candidate");
    if (record.host === "windows-wsl2" && !record.rebootContinuation)
      throw new Error("Windows restart continuation was not tested");
    for (const [role, pin] of Object.entries(manifest.images))
      if (record.images[role] !== pin.digest) throw new Error("Acceptance used different images");
    seen.add(key);
  }
  const missing = required.filter((key) => !seen.has(key));
  if (missing.length) throw new Error(`Missing real-machine acceptance: ${missing.join(", ")}`);
  return {
    version: manifest.version,
    commit: manifest.commit,
    manifestSha256: digest,
    tested: [...seen].sort(),
  };
}

// Require the retained evidence bytes as well as a receipt. Matching the hash prevents an
// accidentally replaced/missing bundle from passing; a reviewer still authenticates its origin.
export async function verifyEvidence(records, directory) {
  for (const raw of records) {
    const record = DistributionAcceptance.parse(raw);
    const hash = createHash("sha256");
    const path = join(directory, `${record.evidenceSha256}.tgz`);
    let size = 0;
    for await (const chunk of createReadStream(path)) {
      size += chunk.length;
      hash.update(chunk);
    }
    if (!size || hash.digest("hex") !== record.evidenceSha256)
      throw new Error(`Evidence bundle does not match ${record.platform}:${record.host}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [manifest, evidenceDirectory, ...receipts] = process.argv.slice(2);
  if (!manifest || !evidenceDirectory || !receipts.length)
    throw new Error("Usage: acceptance.mjs distribution.json evidence-directory acceptance-*.json");
  const records = await Promise.all(
    receipts.map(async (path) => JSON.parse(await readFile(path, "utf8"))),
  );
  const result = verifyAcceptance(await readFile(manifest), records);
  await verifyEvidence(records, evidenceDirectory);
  console.log(JSON.stringify(result, null, 2));
}
