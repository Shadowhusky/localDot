import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type Notice = {
  name: string;
  version: string;
  fallback?: string;
  files: { name: string; text: string; sha256: string }[];
};
const buildUrl = new URL("../build.mjs", import.meta.url);
const { collectNotices, buildBrain } = (await import(buildUrl.href)) as {
  collectNotices(inputs: string[], workingDirectory: string): Notice[];
  buildBrain(root: string): Promise<unknown>;
};
const owned: string[] = [];
afterEach(() => {
  for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "localdot-brain-licenses-"));
  owned.push(root);
  const input = (name: string, version: string, license?: string, repo?: string) => {
    const dir = join(
      root,
      "node_modules/.pnpm",
      `${name.replace("/", "+")}@${version}`,
      "node_modules",
      name,
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name,
        version,
        license: "Apache-2.0",
        repository: { url: repo ?? "https://github.com/vercel/ai" },
      }),
    );
    if (license !== undefined) writeFileSync(join(dir, "LICENSE"), license);
    return { dir, path: join(dir, "dist/index.js") };
  };
  return { root, input };
}

describe("bundle notice accounting", () => {
  it("accounts for every bundled package instance and copies NOTICE as well as LICENSE", () => {
    const f = fixture();
    const one = f.input("@scope/package", "1.0.0", "license one");
    const two = f.input("@scope/package", "2.0.0", "license two");
    writeFileSync(join(two.dir, "NOTICE.txt"), "notice two");
    const records = collectNotices([one.path, two.path, one.path], f.root);
    expect(records.map((r) => r.version)).toEqual(["1.0.0", "2.0.0"]);
    expect(records[1]?.files.map((f) => f.text)).toEqual(["license two", "notice two"]);
    expect(records.every((r) => r.files.every((f) => /^[a-f0-9]{64}$/.test(f.sha256)))).toBe(true);
  });
  it("refuses missing or empty licenses instead of silently omitting bundled code", () => {
    const f = fixture();
    const missing = f.input("unlicensed", "1.0.0");
    expect(() => collectNotices([missing.path], f.root)).toThrow("no verified license");
    writeFileSync(join(missing.dir, "LICENSE"), " ");
    expect(() => collectNotices([missing.path], f.root)).toThrow("empty notice");
  });
  it("accepts only the audited exact provider-utils/ai same-repository license fallback", () => {
    const f = fixture();
    const ai = f.input("ai", "7.0.123", "Apache repository license");
    const utils = f.input("@ai-sdk/provider-utils", "5.0.52");
    const notices = collectNotices([utils.path, ai.path], f.root);
    expect(notices.find((n) => n.name === "@ai-sdk/provider-utils")).toMatchObject({
      fallback: "ai@7.0.123 (same repository and Apache-2.0 license)",
      files: [{ text: "Apache repository license" }],
    });
    const future = f.input("@ai-sdk/provider-utils", "99.0.0");
    expect(() => collectNotices([future.path, ai.path], f.root)).toThrow("no verified license");
    writeFileSync(
      join(utils.dir, "package.json"),
      JSON.stringify({
        name: "@ai-sdk/provider-utils",
        version: "5.0.52",
        license: "Apache-2.0",
        repository: "https://example.invalid/different",
      }),
    );
    expect(() => collectNotices([utils.path, ai.path], f.root)).toThrow("no verified license");
  });
  it("does not publish an unlicensed bundle when accounting rejects a real bundled dependency", async () => {
    const f = fixture();
    const missing = f.input("unlicensed", "1.0.0");
    mkdirSync(join(missing.dir, "dist"), { recursive: true });
    writeFileSync(missing.path, "export const x = 1;\n");
    writeFileSync(
      join(missing.dir, "package.json"),
      JSON.stringify({
        name: "unlicensed",
        version: "1.0.0",
        type: "module",
        exports: "./dist/index.js",
      }),
    );
    mkdirSync(join(f.root, "src"), { recursive: true });
    writeFileSync(
      join(f.root, "src/main.ts"),
      `import { x } from ${JSON.stringify(missing.path)}; console.log(x);\n`,
    );
    await expect(buildBrain(f.root)).rejects.toThrow("no verified license");
    expect(existsSync(join(f.root, "dist/brain.mjs"))).toBe(false);
  });
});
