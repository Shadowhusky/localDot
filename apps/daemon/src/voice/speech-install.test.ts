import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpeechCatalog, SpeechSource } from "./speech-catalog.ts";
import { type RunEngine, SpeechInstaller, SpeechInstallRefused } from "./speech-install.ts";

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
vi.setConfig({ hookTimeout: 30_000 });
const HOST = {
  platform: "darwin",
  arch: "arm64",
  memoryBytes: 16 * 1024 ** 3,
  cpus: 8,
};

let dir: string;
let home: string;
let served: Map<string, Buffer>;
let asked: { url: string; range: string | undefined }[];
let failing: Set<string>;
let hang: Set<string>;
let runs: { binary: string; args: readonly string[] }[];
let run: RunEngine;
let free: number;
const installers: SpeechInstaller[] = [];

function pack(name: string, root: string, files: Record<string, string>): SpeechSource {
  const src = join(dir, `src-${name}`);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(src, root, path, ".."), { recursive: true });
    writeFileSync(join(src, root, path), body);
  }
  const archive = join(dir, `${name}.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", src, root]);
  const bytes = readFileSync(archive);
  const url = `https://downloads.test/${name}.tar.gz`;
  served.set(url, bytes);
  return { url, sha256: sha(bytes), bytes: bytes.length, root };
}

const pins = (files: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(files).map(([path, body]) => [
      path,
      { sha256: sha(body), bytes: Buffer.byteLength(body) },
    ]),
  );

const ENGINE_FILES = { "bin/engine": "#!/bin/sh\n", "lib/libonnx.dylib": "library" };
const LIGHT_FILES = { "model.onnx": "light model", "tokens.txt": "light tokens" };
// A folder among its files, as Qwen3-ASR's tokenizer is.
const LANGUAGES_FILES = {
  "model.onnx": "languages model",
  "tokens.txt": "languages tokens",
  "tokenizer/vocab.json": "{}",
};

function catalog(): SpeechCatalog {
  return {
    engine: {
      version: "1.0.0",
      binary: "bin/engine",
      targets: {
        "darwin-arm64": {
          files: pins(ENGINE_FILES),
          sources: [pack("engine", "engine-root", ENGINE_FILES)],
          libraryPaths: [".", "../lib", "../../../sherpa_onnx/lib"],
        },
      },
    },
    tiers: [
      {
        id: "light",
        name: "Light",
        summary: "Quick.",
        credit: "Light model, MIT",
        languages: ["zh", "en"],
        memoryBytes: 300 * 1024 ** 2,
        minimumMemoryBytes: 4 * 1024 ** 3,
        startSeconds: 0.2,
        relativeCost: 0.02,
        flags: { model: "model.onnx", tokens: "tokens.txt" },
        args: ["--extra=1"],
        files: pins(LIGHT_FILES),
        sources: [pack("light", "light-root", LIGHT_FILES)],
      },
      {
        id: "languages",
        name: "Most languages",
        summary: "Accurate.",
        credit: "Languages model, MIT",
        languages: null,
        memoryBytes: 2 * 1024 ** 3,
        minimumMemoryBytes: 16 * 1024 ** 3,
        startSeconds: 1,
        relativeCost: 0.2,
        flags: { model: "model.onnx", tokens: "tokens.txt" },
        args: [],
        files: pins(LANGUAGES_FILES),
        sources: [pack("languages", "languages-root", LANGUAGES_FILES)],
      },
    ],
  };
}

function installer(over: Partial<ConstructorParameters<typeof SpeechInstaller>[0]> = {}) {
  const made = new SpeechInstaller({
    home,
    catalog: over.catalog ?? pinned,
    host: HOST,
    freeBytes: () => free,
    run: (binary, args, signal) => run(binary, args, signal),
    waitMs: 1,
    fetch: async (url, init) => {
      asked.push({ url, range: init.headers.range });
      if (hang.has(url))
        return new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        });
      const bytes = served.get(url);
      if (!bytes || failing.has(url)) {
        const missing = new Response("gone", { status: 404 });
        Object.defineProperty(missing, "url", { value: url });
        return missing;
      }
      const start = Number(init.headers.range?.match(/bytes=(\d+)-/)?.[1] ?? 0);
      const response = new Response(bytes.subarray(start), {
        status: start ? 206 : 200,
        headers: start
          ? { "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` }
          : {},
      });
      Object.defineProperty(response, "url", { value: url });
      return response;
    },
    ...over,
  });
  installers.push(made);
  return made;
}

const settled = (speech: SpeechInstaller) =>
  vi.waitFor(() => expect(speech.status().job?.state).not.toBe("running"), { timeout: 25_000 });

let pinned: SpeechCatalog;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ld-speech-install-"));
  home = join(dir, "home");
  mkdirSync(home, { mode: 0o700 });
  served = new Map();
  asked = [];
  failing = new Set();
  hang = new Set();
  runs = [];
  free = 100 * 1024 ** 3;
  run = async (binary, args) => {
    runs.push({ binary, args });
    return '{"text": ""}';
  };
  pinned = catalog();
});

afterEach(async () => {
  for (const made of installers.splice(0)) await made.close();
  rmSync(dir, { recursive: true, force: true });
});

const speechDir = () => join(home, "speech");

// Real tar runs, which a busy machine can take seconds to start.
describe("installing speech", { timeout: 30_000 }, () => {
  it("does nothing, and fetches nothing, until someone presses Install", async () => {
    const speech = installer();
    await speech.ready;
    expect(speech.status().job).toBeNull();
    expect(speech.status().installed).toBeNull();
    expect(asked).toEqual([]);
    expect(existsSync(speechDir())).toBe(false);
  });

  it("downloads, unpacks, tries it, then reports it installed under localDot's own home", async () => {
    const speech = installer();
    await speech.ready;
    speech.start("light");
    await settled(speech);
    expect(speech.status().job).toBeNull();
    expect(speech.status().installed).toMatchObject({ tier: "light", damaged: false });
    const model = speech.model();
    expect(model?.binary).toBe(join(speechDir(), "engine", "1.0.0", "bin/engine"));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.binary).toBe(model?.binary);
    expect(runs[0]?.args.some((arg) => arg.startsWith("--model="))).toBe(true);
    expect(model?.args).toEqual(
      expect.arrayContaining([`--model=${join(speechDir(), "models", "light", "model.onnx")}`]),
    );
    expect(readdirSync(join(speechDir(), "partial"))).toEqual([]);
    expect(readFileSync(join(speechDir(), "NOTICES.txt"), "utf8")).toContain("Light model, MIT");
  });

  it("calls it failed when the program runs but prints no words", async () => {
    run = async () => "something else entirely";
    const speech = installer();
    await speech.ready;
    speech.start("light");
    await settled(speech);
    expect(speech.status().job).toMatchObject({ state: "failed", problem: "cannot-run" });
    expect(speech.status().installed).toBeNull();
  });

  it("refuses bytes that don't match, and never runs anything", async () => {
    const tampered = catalog();
    const source = tampered.tiers[0]?.sources[0];
    if (source) served.set(source.url, Buffer.alloc(source.bytes, 9));
    const speech = installer({ catalog: tampered });
    await speech.ready;
    speech.start("light");
    await settled(speech);
    expect(speech.status().job).toMatchObject({ state: "failed", problem: "verify" });
    expect(runs).toEqual([]);
    expect(speech.model()).toBeNull();
    expect(speech.status().installed).toBeNull();
  });

  it("refuses an archive whose unpacked files don't match their pins", async () => {
    const wrong = catalog();
    const tier = wrong.tiers[0];
    if (tier) tier.files = { ...tier.files, "model.onnx": { sha256: sha("other"), bytes: 5 } };
    const speech = installer({ catalog: wrong });
    await speech.ready;
    speech.start("light");
    await settled(speech);
    expect(speech.status().job).toMatchObject({ state: "failed", problem: "verify" });
    expect(runs).toEqual([]);
    expect(speech.model()).toBeNull();
  });

  it("won't run a program that changed on disk after it was installed", async () => {
    const first = installer();
    await first.ready;
    first.start("light");
    await settled(first);
    expect(first.model()).not.toBeNull();
    await first.close();
    writeFileSync(join(speechDir(), "engine", "1.0.0", "bin/engine"), "#!/bin/sh\nevil\n");
    const later = installer();
    await later.ready;
    expect(later.model()).toBeNull();
    expect(later.status().installed).toMatchObject({ tier: "light", damaged: true });
    expect(later.status().using).toBeNull();
  });

  it("stops using a file changed while localDot runs", async () => {
    const speech = installer();
    await speech.ready;
    speech.start("light");
    await settled(speech);
    writeFileSync(join(speechDir(), "models", "light", "model.onnx"), "something else");
    expect(speech.model()).toBeNull();
    // Its hash is checked again before it's called changed.
    await vi.waitFor(() => expect(speech.status().installed).toMatchObject({ damaged: true }));
  });

  it("falls back to the next source and uses it", async () => {
    const mirrored = catalog();
    const tier = mirrored.tiers[0];
    const good = tier?.sources[0];
    if (tier && good)
      tier.sources = [
        { url: "https://mirror.test/gone.tar.gz", sha256: "a".repeat(64), bytes: 10, root: "x" },
        good,
      ];
    const speech = installer({ catalog: mirrored });
    await speech.ready;
    speech.start("light");
    await settled(speech);
    expect(speech.status().installed).toMatchObject({ tier: "light" });
    expect(asked.map(({ url }) => url)).toContain("https://mirror.test/gone.tar.gz");
  });

  it("says when a download can't be reached, and Retry carries on", async () => {
    const light = pinned.tiers[0]?.sources[0]?.url ?? "";
    failing.add(light);
    const speech = installer({ attempts: 1 });
    await speech.ready;
    speech.start("light");
    await settled(speech);
    expect(speech.status().job).toMatchObject({
      state: "failed",
      stage: "model",
      problem: "network",
    });
    expect(speech.status().job?.message).toMatch(/couldn't/i);
    failing.clear();
    asked = [];
    speech.start("light");
    await settled(speech);
    expect(speech.status().installed).toMatchObject({ tier: "light" });
    expect(asked.map(({ url }) => url)).toEqual([light]);
  });

  it("checks the disk first and asks for what is really needed", async () => {
    free = 10;
    const speech = installer();
    await speech.ready;
    speech.start("light");
    await settled(speech);
    expect(speech.status().job).toMatchObject({ state: "failed", problem: "disk" });
    expect(speech.status().job?.message).toMatch(/free/);
    expect(asked).toEqual([]);
    expect(runs).toEqual([]);
  });

  it("cancels at once, removes what it fetched, and leaves nothing installed", async () => {
    const url = pinned.engine.targets["darwin-arm64"]?.sources[0]?.url ?? "";
    hang.add(url);
    const speech = installer();
    await speech.ready;
    speech.start("light");
    await vi.waitFor(() => expect(asked.map((one) => one.url)).toContain(url), { timeout: 25_000 });
    expect(speech.status().job).toMatchObject({ state: "running", stage: "program" });
    await speech.cancel();
    expect(speech.status().job).toBeNull();
    expect(speech.status().installed).toBeNull();
    expect(existsSync(join(speechDir(), "partial"))).toBe(false);
    expect(runs).toEqual([]);
  });

  it("keeps an installed tier working while another downloads, and if cancelled", async () => {
    const speech = installer();
    await speech.ready;
    speech.start("light");
    await settled(speech);
    const before = speech.model();
    hang.add(pinned.tiers[1]?.sources[0]?.url ?? "");
    speech.start("languages");
    await vi.waitFor(() => expect(speech.status().job?.stage).toBe("model"), { timeout: 25_000 });
    expect(speech.model()).toEqual(before);
    await speech.cancel();
    expect(speech.model()).toEqual(before);
    expect(speech.status().installed).toMatchObject({ tier: "light" });
  });

  it("swaps to the new tier when it is ready and drops the old model", async () => {
    const speech = installer();
    await speech.ready;
    speech.start("light");
    await settled(speech);
    speech.start("languages");
    await settled(speech);
    expect(speech.status().installed).toMatchObject({ tier: "languages" });
    expect(existsSync(join(speechDir(), "models", "light"))).toBe(false);
    expect(existsSync(join(speechDir(), "models", "languages", "model.onnx"))).toBe(true);
    expect(speech.model()).not.toBeNull();
    expect(asked.filter(({ url }) => url.includes("engine"))).toHaveLength(1);
  });

  it("presses from two devices become one install; another tier waits its turn", async () => {
    hang.add(pinned.engine.targets["darwin-arm64"]?.sources[0]?.url ?? "");
    const speech = installer();
    await speech.ready;
    speech.start("light");
    expect(() => speech.start("light")).not.toThrow();
    expect(() => speech.start("languages")).toThrow(SpeechInstallRefused);
    await vi.waitFor(() => expect(asked).toHaveLength(1), { timeout: 25_000 });
    await speech.cancel();
  });

  it("tells a restart apart from a failure, keeps the bytes, and only continues on a press", async () => {
    const url = pinned.engine.targets["darwin-arm64"]?.sources[0]?.url ?? "";
    const whole = served.get(url) ?? Buffer.alloc(0);
    const part = whole.subarray(0, 20);
    const first = installer({
      fetch: async (_url, init) => {
        let sent = false;
        const response = new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init.signal.addEventListener("abort", () => controller.error(init.signal.reason), {
                once: true,
              });
            },
            pull(controller) {
              if (sent) return;
              sent = true;
              controller.enqueue(part);
            },
          }),
        );
        Object.defineProperty(response, "url", { value: url });
        return response;
      },
    });
    await first.ready;
    first.start("light");
    await vi.waitFor(() => expect(first.status().job?.doneBytes).toBe(20), { timeout: 25_000 });
    await first.close();
    asked = [];
    const restarted = installer();
    await restarted.ready;
    expect(restarted.status().job).toMatchObject({
      state: "failed",
      problem: "interrupted",
      stage: "program",
    });
    expect(asked).toEqual([]);
    restarted.start("light");
    await settled(restarted);
    expect(asked[0]?.range).toBe("bytes=20-");
    expect(restarted.status().installed).toMatchObject({ tier: "light" });
    expect(restarted.status().job).toBeNull();
  });

  it("says plainly when the program can't run on this computer", async () => {
    run = async () => {
      throw Object.assign(new Error("dyld: Library not loaded"), { code: 1 });
    };
    const speech = installer();
    await speech.ready;
    speech.start("light");
    await settled(speech);
    expect(speech.status().job).toMatchObject({ state: "failed", problem: "cannot-run" });
    expect(speech.model()).toBeNull();
    expect(speech.status().job?.message).not.toContain("dyld");
  });

  it("removes only what it installed", async () => {
    const hand = join(dir, "whisper.cpp");
    mkdirSync(hand);
    writeFileSync(join(hand, "ggml-base.bin"), "hand-installed");
    const binary = join(dir, "whisper-cli");
    writeFileSync(binary, "hand-installed");
    chmodSync(binary, 0o755);
    const speech = installer();
    await speech.ready;
    speech.start("light");
    await settled(speech);
    await speech.remove();
    expect(existsSync(speechDir())).toBe(false);
    expect(speech.model()).toBeNull();
    expect(speech.status().installed).toBeNull();
    expect(readFileSync(join(hand, "ggml-base.bin"), "utf8")).toBe("hand-installed");
    expect(readFileSync(binary, "utf8")).toBe("hand-installed");
  });

  it("refuses to remove while an install is under way", async () => {
    hang.add(pinned.engine.targets["darwin-arm64"]?.sources[0]?.url ?? "");
    const speech = installer();
    await speech.ready;
    speech.start("light");
    await expect(speech.remove()).rejects.toBeInstanceOf(SpeechInstallRefused);
    await speech.cancel();
  });

  it("offers nothing on a system it has no program for", async () => {
    const speech = installer({ host: { ...HOST, platform: "freebsd", arch: "x64" } });
    await speech.ready;
    expect(speech.status().supported).toBe(false);
    expect(() => speech.start("light")).toThrow(SpeechInstallRefused);
    expect(asked).toEqual([]);
  });

  it("refuses a tier it doesn't know", async () => {
    const speech = installer();
    await speech.ready;
    expect(() => speech.start("balanced")).toThrow(SpeechInstallRefused);
  });

  it("is a private folder others can't read", async () => {
    const speech = installer();
    await speech.ready;
    speech.start("light");
    await settled(speech);
    expect(execFileSync("stat", statMode(speechDir()), { encoding: "utf8" }).trim()).toBe("700");
  });
});

describe("what installed.json may decide", { timeout: 30_000 }, () => {
  const record = (value: unknown) => {
    mkdirSync(speechDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(speechDir(), "installed.json"), JSON.stringify(value));
  };
  const forged = (engineVersion: string) => ({
    tier: "light",
    engineVersion,
    binary: "../../../../../../../../../../../../../../bin/sh",
    engineFiles: {},
    modelFiles: {},
    flags: {},
    args: ["-c", "echo ran"],
    languages: null,
  });

  it("never takes the program, its arguments or its files from it", async () => {
    record(forged("1.0.0"));
    const speech = installer();
    await speech.ready;
    expect(speech.model()).toBeNull();
    expect(JSON.stringify(speech.status())).not.toContain("bin/sh");
  });

  it("runs what the catalog names once the files are in place", async () => {
    const first = installer();
    await first.ready;
    first.start("light");
    await settled(first);
    await first.close();
    expect(JSON.parse(readFileSync(join(speechDir(), "installed.json"), "utf8"))).toEqual({
      tier: "light",
      engineVersion: "1.0.0",
    });
    const later = installer();
    await later.ready;
    expect(later.model()?.binary).toBe(join(speechDir(), "engine", "1.0.0", "bin/engine"));
    expect(later.model()?.args).toContain("--extra=1");
  });

  it("asks for a reinstall when it names a version the catalog doesn't, and deletes nothing outside", async () => {
    const victim = join(home, "victim");
    mkdirSync(victim);
    writeFileSync(join(victim, "keep.txt"), "user data");
    for (const value of [
      forged("../../victim"),
      { tier: "light", engineVersion: "../../victim" },
    ]) {
      record(value);
      const speech = installer();
      await speech.ready;
      expect(speech.model()).toBeNull();
      if (Object.keys(value).length === 2)
        expect(speech.status().installed).toMatchObject({
          tier: "light",
          damaged: true,
          reason: "outdated",
        });
      speech.start("languages");
      await settled(speech);
      expect(speech.status().installed).toMatchObject({ tier: "languages", damaged: false });
      expect(readFileSync(join(victim, "keep.txt"), "utf8")).toBe("user data");
      await speech.close();
      rmSync(speechDir(), { recursive: true, force: true });
    }
  });

  it("removes an old folder that's a link as the link, never what it points to", async () => {
    const speech = installer();
    await speech.ready;
    speech.start("light");
    await settled(speech);
    const outside = join(home, "elsewhere");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "user data");
    symlinkSync(outside, join(speechDir(), "engine", "0.9.0"));
    symlinkSync(outside, join(speechDir(), "models", "old"));
    speech.start("languages");
    await settled(speech);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("user data");
    expect(existsSync(join(speechDir(), "engine", "0.9.0"))).toBe(false);
    expect(existsSync(join(speechDir(), "models", "old"))).toBe(false);
  });

  it("deletes nothing through a folder swapped for a link", async () => {
    const speech = installer();
    await speech.ready;
    speech.start("light");
    await settled(speech);
    const outside = join(home, "elsewhere");
    renameSync(join(speechDir(), "models"), outside);
    symlinkSync(outside, join(speechDir(), "models"));
    speech.start("languages");
    await settled(speech);
    expect(existsSync(join(outside, "light", "model.onnx"))).toBe(true);
    expect(lstatSync(join(speechDir(), "models")).isSymbolicLink()).toBe(false);
    expect(speech.status().installed).toMatchObject({ tier: "languages", damaged: false });
  });
});

describe("what runs beside the program", { timeout: 30_000 }, () => {
  const installed = async () => {
    const speech = installer();
    await speech.ready;
    speech.start("light");
    await settled(speech);
    expect(speech.model()).not.toBeNull();
    return speech;
  };
  const engineDir = () => join(speechDir(), "engine", "1.0.0");

  it("won't run with an unpinned file beside the program", async () => {
    const speech = await installed();
    writeFileSync(join(engineDir(), "bin", "libonnx.dylib"), "planted");
    expect(speech.model()).toBeNull();
    expect(speech.status().installed).toMatchObject({ damaged: true, reason: "changed" });
  });

  it("won't run with a library folder the program searches outside its own", async () => {
    const speech = await installed();
    mkdirSync(join(speechDir(), "sherpa_onnx", "lib"), { recursive: true });
    writeFileSync(join(speechDir(), "sherpa_onnx", "lib", "libstdc++.so.6"), "planted");
    expect(speech.model()).toBeNull();
  });

  it("won't run with an unpinned file beside the model, or a pinned one made a link", async () => {
    const speech = await installed();
    writeFileSync(join(speechDir(), "models", "light", "extra.onnx"), "planted");
    expect(speech.model()).toBeNull();
    const again = await (async () => {
      rmSync(speechDir(), { recursive: true, force: true });
      return installed();
    })();
    const binary = join(engineDir(), "bin", "engine");
    const copy = join(home, "engine-copy");
    renameSync(binary, copy);
    symlinkSync(copy, binary);
    expect(again.model()).toBeNull();
  });

  it("installing again clears what was planted and runs once more", async () => {
    const speech = await installed();
    writeFileSync(join(engineDir(), "bin", "libonnx.dylib"), "planted");
    mkdirSync(join(speechDir(), "sherpa_onnx", "lib"), { recursive: true });
    expect(speech.model()).toBeNull();
    speech.start("light");
    await settled(speech);
    expect(speech.status().job).toBeNull();
    expect(existsSync(join(engineDir(), "bin", "libonnx.dylib"))).toBe(false);
    expect(existsSync(join(speechDir(), "sherpa_onnx", "lib"))).toBe(false);
    expect(speech.model()).not.toBeNull();
  });
});

describe("what the re-check found", { timeout: 30_000 }, () => {
  it("uses a file again once its hash still matches after something only touched it", async () => {
    const speech = installer();
    await speech.ready;
    speech.start("light");
    await settled(speech);
    chmodSync(join(speechDir(), "models", "light", "tokens.txt"), 0o600);
    expect(speech.model()).toBeNull();
    await vi.waitFor(() => expect(speech.model()).not.toBeNull());
    expect(speech.status().installed).toMatchObject({ damaged: false });
  });

  const installed = async (tier = "light") => {
    const speech = installer();
    await speech.ready;
    speech.start(tier);
    await settled(speech);
    expect(speech.model()).not.toBeNull();
    return speech;
  };
  const outside = () => join(dir, "outside");

  it("won't run when a folder on the way to the program or model is a link", async () => {
    for (const folder of ["engine", "models", "engine/1.0.0", "models/light"]) {
      rmSync(speechDir(), { recursive: true, force: true });
      rmSync(outside(), { recursive: true, force: true });
      const speech = await installed();
      mkdirSync(outside(), { recursive: true });
      renameSync(join(speechDir(), folder), join(outside(), "moved"));
      symlinkSync(join(outside(), "moved"), join(speechDir(), folder));
      expect(speech.model(), folder).toBeNull();
      await speech.close();
      const fresh = installer();
      await fresh.ready;
      expect(fresh.model(), `${folder} after a restart`).toBeNull();
    }
  });

  it("won't run when speech/ itself is a link", async () => {
    await installed();
    mkdirSync(outside(), { recursive: true });
    renameSync(speechDir(), join(outside(), "speech"));
    symlinkSync(join(outside(), "speech"), speechDir());
    const fresh = installer();
    await fresh.ready;
    expect(fresh.model()).toBeNull();
  });

  it("checks a program edited in place again, even with its size, inode and time put back", async () => {
    const speech = await installed();
    const bin = join(speechDir(), "engine", "1.0.0", "bin", "engine");
    const before = statSync(bin, { bigint: true });
    writeFileSync(bin, "#!/bin/sx\n");
    execFileSync("python3", [
      "-I",
      "-c",
      "import os,sys; os.utime(sys.argv[1], ns=(int(sys.argv[2]), int(sys.argv[3])))",
      bin,
      String(before.atimeNs),
      String(before.mtimeNs),
    ]);
    const after = statSync(bin, { bigint: true });
    expect([after.size, after.ino, after.mtimeNs]).toEqual([
      before.size,
      before.ino,
      before.mtimeNs,
    ]);
    expect(speech.model()).toBeNull();
    await vi.waitFor(() =>
      expect(speech.status().installed).toMatchObject({ damaged: true, reason: "changed" }),
    );
  });

  it("checks the program again just before its first run", async () => {
    await installed("light");
    // A short stall limit, so the held download gives up and asks again once it's let go.
    const speech = installer({ stallMs: 300 });
    await speech.ready;
    hang.add(pinned.tiers[1]?.sources[0]?.url ?? "");
    const seen: string[] = [];
    run = async (binary) => {
      seen.push(readdirSync(join(binary, "..")).join(","));
      return '{"text": ""}';
    };
    speech.start("languages");
    await vi.waitFor(() => expect(speech.status().job?.stage).toBe("model"), { timeout: 25_000 });
    writeFileSync(join(speechDir(), "engine", "1.0.0", "bin", "libonnx.dylib"), "planted");
    hang.clear();
    await settled(speech);
    expect(seen).toEqual([]);
    expect(speech.status().job).toMatchObject({ state: "failed", problem: "verify" });
    speech.start("languages");
    await settled(speech);
    expect(seen).toEqual(["engine"]);
    expect(speech.model()).not.toBeNull();
  });

  it("deletes nothing when cancelling while speech/ is a link", async () => {
    const target = join(dir, "projects");
    mkdirSync(join(target, "partial"), { recursive: true });
    mkdirSync(join(target, "engine", "keep"), { recursive: true });
    writeFileSync(join(target, "partial", "user-file.txt"), "mine");
    writeFileSync(join(target, "engine", "keep", "user.txt"), "mine");
    writeFileSync(
      join(target, "installing.json"),
      JSON.stringify({ tier: "light", stage: "model" }),
    );
    symlinkSync(target, speechDir());
    const speech = installer();
    await speech.ready;
    expect(speech.status().job).toMatchObject({ problem: "interrupted" });
    await speech.cancel();
    expect(readFileSync(join(target, "partial", "user-file.txt"), "utf8")).toBe("mine");
    expect(readFileSync(join(target, "engine", "keep", "user.txt"), "utf8")).toBe("mine");
    expect(existsSync(join(target, "installing.json"))).toBe(true);
  });
});

describe("cancelling", { timeout: 30_000 }, () => {
  it("refuses a new press until the clean-up is done, then installs", async () => {
    const url = pinned.tiers[0]?.sources[0]?.url ?? "";
    hang.add(url);
    const speech = installer();
    await speech.ready;
    speech.start("light");
    await vi.waitFor(() => expect(speech.status().job?.stage).toBe("model"), { timeout: 25_000 });
    hang.clear();
    const cancelled = speech.cancel();
    expect(() => speech.start("light")).toThrow(SpeechInstallRefused);
    await expect(speech.remove()).rejects.toBeInstanceOf(SpeechInstallRefused);
    await cancelled;
    expect(speech.status().job).toBeNull();
    speech.start("light");
    await settled(speech);
    expect(speech.status().installed).toMatchObject({ tier: "light", damaged: false });
  });
});

describe("a source with bad bytes", { timeout: 30_000 }, () => {
  it("is downloaded once, then the next source is used", async () => {
    const mirrored = catalog();
    const tier = mirrored.tiers[0];
    const good = tier?.sources[0];
    if (!tier || !good) throw new Error("catalog");
    const bad = { ...good, url: "https://mirror.test/light.tar.gz" };
    served.set(bad.url, Buffer.alloc(good.bytes, 3));
    tier.sources = [bad, good];
    const speech = installer({ catalog: mirrored });
    await speech.ready;
    speech.start("light");
    await settled(speech);
    expect(speech.status().installed).toMatchObject({ tier: "light" });
    expect(asked.filter(({ url }) => url === bad.url)).toHaveLength(1);
  });
});

const statMode = (path: string) =>
  process.platform === "darwin" ? ["-f", "%Lp", path] : ["-c", "%a", path];
