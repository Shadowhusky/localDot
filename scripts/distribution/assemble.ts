import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { authenticatedCatalog, validateCatalog } from "./catalog.ts";

/** Create a testing-channel site from previously verified packages. Never uploads source or keys. */
export async function assemble(input: {
  packages: string[];
  images: unknown;
  key: string;
  output: string;
  // Freeze the old channel at the bridge release; do not strand older verifiers.
  legacyCatalog?: string;
  migrationBridge?: boolean;
}) {
  const st = await lstat(input.key);
  if (!st.isFile() || st.isSymbolicLink() || st.mode & 0o077 || st.uid !== process.getuid?.())
    throw new Error("The release signing key must be an owner-only local file.");
  const key = createPrivateKey(await readFile(input.key));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("An Ed25519 release key is required.");
  const entries = await Promise.all(
    input.packages.map(async (dir) => {
      const receipt = JSON.parse(await readFile(join(dir, "artifact.json"), "utf8"));
      const check = JSON.parse(await readFile(join(dir, "verification.json"), "utf8"));
      if (
        check.version !== receipt.version ||
        check.target !== receipt.target ||
        check.sha512 !== receipt.artifact.sha512 ||
        [
          "inventory",
          "cli",
          "nativeImageModule",
          "helper",
          "nativeRecovery",
          "daemon",
          "webAssets",
        ].some((field) => check[field] !== true)
      )
        throw new Error("A package is missing matching runtime verification.");
      const bytes = await readFile(join(dir, basename(new URL(receipt.artifact.url).pathname)));
      if (
        bytes.length !== receipt.artifact.bytes ||
        createHash("sha512").update(bytes).digest("hex") !== receipt.artifact.sha512
      )
        throw new Error("A verified archive changed.");
      const bootstrap = await readFile(join(dir, "bootstrap.mjs"));
      if (createHash("sha256").update(bootstrap).digest("hex") !== receipt.bootstrapSHA256)
        throw new Error("The installer bootstrap changed.");
      // The signature below must be understood by the key compiled into every bootstrap.
      if (
        !bootstrap
          .toString()
          .includes(
            createPublicKey(key)
              .export({ type: "spki", format: "pem" })
              .toString()
              .trim()
              .split("\n")[1] ?? "NO KEY",
          )
      )
        throw new Error("The package bootstrap uses a different signing key.");
      return { dir, receipt };
    }),
  );
  const first = entries[0];
  if (!first) throw new Error("At least one verified package is required.");
  const { version, commit, bootstrapSHA256 } = first.receipt;
  if (!/^\d+\.\d+\.\d+-rc\.\d+$/.test(version))
    throw new Error("This publisher only creates testing releases.");
  if (
    entries.some(
      ({ receipt: r }) =>
        r.version !== version || r.commit !== commit || r.bootstrapSHA256 !== bootstrapSHA256,
    ) ||
    new Set(entries.map(({ receipt: r }) => r.target)).size !== entries.length
  )
    throw new Error("Release packages do not belong together.");
  const catalog = validateCatalog({
    v: 1,
    version,
    commit,
    images: input.images,
    platforms: Object.fromEntries(entries.map(({ receipt: r }) => [r.target, r.artifact])),
  });
  const signedCatalog = (value: unknown) => {
    const payload = Buffer.from(JSON.stringify(validateCatalog(value)));
    return JSON.stringify({
      payload: payload.toString("base64"),
      signature: sign(null, payload, key).toString("base64"),
    });
  };
  const signed = signedCatalog(catalog);
  if (!!input.migrationBridge === !!input.legacyCatalog)
    throw new Error("Preserve the legacy catalog, or explicitly publish the migration bridge.");
  const legacy = input.migrationBridge
    ? signedCatalog({
        ...catalog,
        platforms: Object.fromEntries(
          Object.entries(catalog.platforms).map(([target, artifact]) => [
            target,
            {
              ...artifact,
              url: artifact.url.replace("/localdot/releases/", "/localdot-downloads/releases/"),
            },
          ]),
        ),
      })
    : await readFile(input.legacyCatalog ?? "", "utf8");
  const legacyRelease = authenticatedCatalog(
    legacy,
    createPublicKey(key).export({ type: "spki", format: "pem" }).toString(),
  );
  if (
    Object.values(legacyRelease.platforms).some(
      (a) => !a.url.includes("/localdot-downloads/releases/"),
    )
  )
    throw new Error("Legacy installers require the original repository URLs.");
  authenticatedCatalog(
    signed,
    createPublicKey(key).export({ type: "spki", format: "pem" }).toString(),
  );
  await mkdir(input.output, { mode: 0o700 });
  await mkdir(join(input.output, "channels"));
  await mkdir(join(input.output, "bootstrap"));
  await writeFile(join(input.output, "channels", "testing.json"), legacy);
  await writeFile(join(input.output, "channels", "releases.json"), signed);
  for (const name of ["install.sh", "install.ps1"])
    await copyFile(join(first.dir, name), join(input.output, name));
  await copyFile(
    join(first.dir, "bootstrap.mjs"),
    join(input.output, "bootstrap", `${bootstrapSHA256}.mjs`),
  );
  await writeFile(
    join(input.output, "_headers"),
    "/install.sh\n  Cache-Control: no-store\n  Content-Type: text/plain; charset=utf-8\n/install.ps1\n  Cache-Control: no-store\n  Content-Type: text/plain; charset=utf-8\n/channels/*\n  Cache-Control: no-store\n/bootstrap/*\n  Cache-Control: public, max-age=31536000, immutable\n",
  );
  console.log(
    `Prepared signed testing channel ${version} for ${entries.map(({ receipt: r }) => r.target).join(", ")}.`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const file = process.argv[2];
  if (!file) throw new Error("Usage: assemble.ts publish-input.json");
  await assemble(JSON.parse(await readFile(file, "utf8")));
}
