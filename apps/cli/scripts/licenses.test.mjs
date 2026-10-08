import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { writeDependencyNotices } from "./licenses.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "localdot-notices-"));
  roots.push(root);
  const pkg = join(root, "node_modules/@fixture/lib");
  await mkdir(join(pkg, "dist"), { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({ name: "@fixture/lib", version: "1.2.3", license: "MIT" }),
  );
  await writeFile(join(pkg, "dist/package.json"), JSON.stringify({ type: "module" }));
  const outDir = join(root, "out");
  const run = () =>
    writeDependencyNotices({
      workspace: root,
      outDir,
      inputs: [
        "node_modules/@fixture/lib/dist/main.js",
        "node_modules/@fixture/lib/dist/other.js",
        "src/local.ts",
        "\0virtual:module",
      ],
    });
  return { root, pkg, outDir, run };
}
it("finds the real package above a nested module descriptor and preserves all notice text once", async () => {
  const f = await fixture();
  const license = "Copyright fixture\nPermission fixture\n";
  await writeFile(join(f.pkg, "LICENSE"), license);
  await writeFile(join(f.pkg, "NOTICE.md"), "Attribution fixture\n");
  const result = await f.run();
  expect(result).toHaveLength(1);
  const output = await readFile(join(f.outDir, result[0].path), "utf8");
  expect(output).toContain(license);
  expect(output).toContain("Attribution fixture\n");
  expect(result[0]).toMatchObject({
    name: "@fixture/lib",
    version: "1.2.3",
    sourceFiles: ["LICENSE", "NOTICE.md"],
  });
});
it("rejects a bundled dependency without its license instead of fabricating legal text", async () => {
  await expect((await fixture()).run()).rejects.toThrow("no license file");
});
it("keeps notices for a compiler input resolved to an unpacked dependency outside node_modules", async () => {
  const f = await fixture();
  const external = join(f.root, "unpacked/package");
  await mkdir(external, { recursive: true });
  await writeFile(
    join(external, "package.json"),
    JSON.stringify({ name: "unpacked-fixture", version: "1.0.0", license: "MIT" }),
  );
  await writeFile(join(external, "LICENSE"), "Unpacked fixture copyright\n");
  await writeFile(join(external, "main.js"), "export {};\n");
  const result = await writeDependencyNotices({
    inputs: [join(external, "main.js")],
    workspace: join(f.root, "workspace"),
    outDir: f.outDir,
  });
  expect(result).toHaveLength(1);
  expect(result[0].name).toBe("unpacked-fixture");
  expect(await readFile(join(f.outDir, result[0].path), "utf8")).toContain(
    "Unpacked fixture copyright",
  );
});
it("uses the pinned upstream license only for the exact incomplete package release", async () => {
  const f = await fixture();
  await writeFile(
    join(f.pkg, "package.json"),
    JSON.stringify({ name: "@pixi/colord", version: "2.9.6", license: "MIT" }),
  );
  const result = await f.run();
  const notice = await readFile(join(f.outDir, result[0].path), "utf8");
  expect(notice).toContain("Copyright (c) 2020 Vlad Shilov");
  expect(result[0].upstream).toContain("5344fbf77b736f81cd33c21050021bc09bc9dd1d");
  await writeFile(
    join(f.pkg, "package.json"),
    JSON.stringify({ name: "@pixi/colord", version: "2.9.7", license: "MIT" }),
  );
  await expect(f.run()).rejects.toThrow("no license file");
});
it("refuses a linked license file and will not overwrite a prior notice", async () => {
  const f = await fixture();
  const outside = join(f.root, "other.txt");
  await writeFile(outside, "private fixture");
  await symlink(outside, join(f.pkg, "LICENSE"));
  await expect(f.run()).rejects.toThrow("Invalid dependency license");
  await rm(join(f.pkg, "LICENSE"));
  await writeFile(join(f.pkg, "LICENSE"), "Valid fixture license\n");
  await f.run();
  await expect(f.run()).rejects.toMatchObject({ code: "EEXIST" });
});
